// Execute one worker's tools, preserving approval routing and turn-level side-effect ordering.
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";
import { jevEnabled, judge } from "./approve";
import type { Ev, Settings } from "./shared";
import { validateArgs, type ToolContext } from "./toolkit";
import { describe, errorOutput, parseArgs, summarize, usable } from "./tools";

type RunnerOptions = {
  message: string;
  signal: AbortSignal;
  emit: (ev: Ev) => void;
  chat: ToolContext["chat"];
  team: ToolContext["team"];
  settings: () => Pick<Settings, "model" | "autoApprove">;
  approvals: Map<string, (ok: boolean) => void>;
  cwd: string;
  task: string | (() => string);
  exclusive: (run: () => Promise<string>) => Promise<string>;
  /** Nested Code Mode calls, for the episode trace; outer calls are logged by the agent. */
  onCall?: (call: { name: string; args: string; output: string }) => void;
};

/** One runner per worker; approvals and the side-effect queue remain owned by the turn. */
export function createToolRunner({ message, signal, emit, chat, team, settings, approvals, cwd, task, exclusive, onCall }: RunnerOptions) {
  async function approved(id: string, request: string, callSignal: AbortSignal) {
    callSignal.throwIfAborted();
    if (settings().autoApprove && jevEnabled()) {
      emit({ t: "tool_status", id, status: "judging" });
      const verdict = await judge(request, cwd, typeof task === "function" ? task() : task, callSignal);
      callSignal.throwIfAborted();
      emit({ t: "tool_judge", id, judge: verdict });
      if (verdict.ok) return true;
    }
    callSignal.throwIfAborted();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const abort = () => { cleanup(); reject(callSignal.reason ?? new Error("tool call aborted")); };
        const cleanup = () => callSignal.removeEventListener("abort", abort);
        approvals.set(id, (ok) => { cleanup(); resolve(ok); });
        callSignal.addEventListener("abort", abort, { once: true });
        if (callSignal.aborted) { abort(); return; }
        emit({ t: "tool_status", id, status: "awaiting" });
      });
    } finally { approvals.delete(id); }
  }

  async function call({ call_id, name, arguments: json }: ResponseFunctionToolCall, nestedSignal?: AbortSignal): Promise<string> {
    const callSignal = nestedSignal ? AbortSignal.any([signal, nestedSignal]) : signal;
    callSignal.throwIfAborted();
    const id = `${message}:${call_id}`;
    const parsed = parseArgs(json);
    const a = parsed ?? {};
    const tool = usable(name);
    const ctx: ToolContext = {
      signal: callSignal, model: settings().model, chat, team,
      callTool: async (innerName, args, executionSignal) => {
        callSignal.throwIfAborted();
        if (innerName === "execute_code") throw new Error("recursive execute_code is not allowed");
        const innerJSON = JSON.stringify(args);
        const output = await call({
          type: "function_call", call_id: crypto.randomUUID(), name: innerName, arguments: innerJSON,
        }, executionSignal ? AbortSignal.any([callSignal, executionSignal]) : callSignal);
        onCall?.({ name: innerName, args: innerJSON, output });
        return output;
      },
    };
    if (tool?.silent) {
      try {
        if (!parsed) throw new Error("arguments are not a JSON object");
        validateArgs(tool, a);
        callSignal.throwIfAborted();
        return await tool.run(a, ctx);
      } catch (e) {
        if (callSignal.aborted) throw e;
        return errorOutput((e as Error).message);
      }
    }
    const view = describe(name, a);
    emit({ t: "tool", id, name, args: json, view, summary: summarize(name, a, "running") });
    try {
      if (!tool) throw new Error(`unknown tool ${name}`);
      if (!parsed) throw new Error("arguments are not a JSON object");
      validateArgs(tool, a);
      if (view.request !== undefined && !(await approved(id, view.request, callSignal))) {
        emit({ t: "tool_status", id, status: "denied" });
        return "user denied this command";
      }
      callSignal.throwIfAborted();
      emit({ t: "tool_status", id, status: "running" });
      const run = () => { callSignal.throwIfAborted(); return tool.run(a, ctx); };
      const output = await (["write_file", "edit_file", "bash"].includes(name) ? exclusive(run) : run());
      emit({ t: "tool_status", id, status: "done", output, summary: summarize(name, a, "done", output) });
      return output;
    } catch (e) {
      const output = errorOutput((e as Error).message);
      emit({ t: "tool_status", id, status: "error", output, summary: summarize(name, a, "error", output) });
      if (callSignal.aborted) throw e;
      return output;
    }
  }

  return (fc: ResponseFunctionToolCall) => call(fc);
}
