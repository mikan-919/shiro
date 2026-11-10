// Execute one worker's tools, preserving approval routing and turn-level side-effect ordering.
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";
import { jevEnabled, judge } from "./approve";
import type { Ev, Settings } from "./shared";
import type { ToolContext } from "./toolkit";
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
  task: string;
  exclusive: (run: () => Promise<string>) => Promise<string>;
};

/** One runner per worker; approvals and the side-effect queue remain owned by the turn. */
export function createToolRunner({ message, signal, emit, chat, team, settings, approvals, cwd, task, exclusive }: RunnerOptions) {
  async function approved(id: string, request: string) {
    signal.throwIfAborted();
    if (settings().autoApprove && jevEnabled()) {
      emit({ t: "tool_status", id, status: "judging" });
      const verdict = await judge(request, cwd, task, signal);
      emit({ t: "tool_judge", id, judge: verdict });
      if (verdict.ok) return true;
    }
    signal.throwIfAborted();
    const ok = await new Promise<boolean>((resolve) => {
      approvals.set(id, resolve);
      emit({ t: "tool_status", id, status: "awaiting" });
    });
    approvals.delete(id);
    return ok;
  }

  async function call({ call_id, name, arguments: json }: ResponseFunctionToolCall): Promise<string> {
    signal.throwIfAborted();
    const id = `${message}:${call_id}`;
    const parsed = parseArgs(json);
    const a = parsed ?? {};
    const tool = usable(name);
    const ctx = { signal, model: settings().model, chat, team };
    if (tool?.silent) {
      try {
        if (!parsed) throw new Error("arguments are not a JSON object");
        return await tool.run(a, ctx);
      } catch (e) {
        if (signal.aborted) throw e;
        return errorOutput((e as Error).message);
      }
    }
    const view = describe(name, a);
    emit({ t: "tool", id, name, args: json, view, summary: summarize(name, a, "running") });
    try {
      if (!tool) throw new Error(`unknown tool ${name}`);
      if (!parsed) throw new Error("arguments are not a JSON object");
      if (view.request !== undefined && !(await approved(id, view.request))) {
        emit({ t: "tool_status", id, status: "denied" });
        return "user denied this command";
      }
      emit({ t: "tool_status", id, status: "running" });
      const output = await (["write_file", "edit_file", "bash"].includes(name) ? exclusive(() => tool.run(a, ctx)) : tool.run(a, ctx));
      emit({ t: "tool_status", id, status: "done", output, summary: summarize(name, a, "done", output) });
      return output;
    } catch (e) {
      if (signal.aborted) throw e;
      const output = errorOutput((e as Error).message);
      emit({ t: "tool_status", id, status: "error", output, summary: summarize(name, a, "error", output) });
      return output;
    }
  }

  return call;
}
