// The conversation runtime: turns, approvals and the event stream every open tab follows.
import type { ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import * as store from "./store";
import { respond } from "./codex";
import { available, firstLine, parseArgs, toolNamed } from "./tools";
import { jevEnabled, judge } from "./approve";
import { apply, assistantText, DEFAULTS, type ConvMeta, type ConvView, type Ev, type Message, type Part, type Push, type ToolPart } from "./shared";

type Settings = Pick<ConvMeta, "model" | "effort" | "autoApprove">;
type Turn = { ctl: AbortController; approvals: Map<string, (ok: boolean) => void> };

const errorSummary = (output: string) => firstLine(output.replace(/^error:\s*/, ""));

/** Fills in the view of a tool call stored before calls carried one. */
function withView(p: ToolPart): ToolPart {
  if (p.view) return p;
  const tool = toolNamed(p.name);
  const a = parseArgs(p.args);
  const view = tool?.view(a) ?? { label: p.name, icon: "terminal", target: "" };
  const summary = p.status === "error" ? errorSummary(p.output ?? "") : tool?.summary?.(a, p.status === "done" ? p.output : undefined);
  return { ...p, view, summary };
}

export function createAgent({ publish, cwd, defaultModel }: { publish: (p: Push) => void; cwd: string; defaultModel: string }) {
  const turns = new Map<string, Turn>();
  const seqs = new Map<string, number>();

  const view = (m: ConvMeta): ConvView => ({ ...m, running: turns.has(m.id) });
  const instructions = () => `You are shiro, a coding and everyday agent running on the user's own machine in ${cwd}.
Use the tools to inspect and change files and run commands.
Today is ${new Date().toISOString().slice(0, 10)}. Reply in the user's language. Use Markdown. Be concise.`;

  function emit(c: store.Conv, ev: Ev) {
    c.messages = apply(c.messages, ev);
    const seq = (seqs.get(c.meta.id) ?? 0) + 1;
    seqs.set(c.meta.id, seq);
    publish({ type: "ev", conv: c.meta.id, seq, ev });
  }

  function touch(c: store.Conv) {
    c.meta.updatedAt = Date.now();
    store.save(c);
    publish({ type: "meta", meta: view(c.meta) });
  }

  /** A stored conversation, with whatever an earlier process left unfinished settled. */
  function load(id: string) {
    const c = store.get(id);
    if (!c || turns.has(id)) return c;
    const last = c.messages.at(-1);
    if (last?.role === "assistant" && last.status === "streaming") c.messages = apply(c.messages, { t: "end", status: "stopped" });
    c.messages = c.messages.map((m): Message =>
      m.role === "assistant" ? { ...m, parts: m.parts.map((p): Part => (p.type === "tool" ? withView(p) : p)) } : m,
    );
    return c;
  }

  async function runTurn(c: store.Conv, text: string, images: string[]) {
    const turn: Turn = { ctl: new AbortController(), approvals: new Map() };
    const { signal } = turn.ctl;
    turns.set(c.meta.id, turn);
    // Stopping while a call waits for approval counts as a denial; the next request then sees the abort.
    signal.addEventListener("abort", () => turn.approvals.forEach((resolve) => resolve(false)));
    const itemIndex = c.items.length;
    if (!c.messages.length) c.meta.title = text.replace(/\s+/g, " ").trim().slice(0, 40) || "画像";
    emit(c, { t: "user", msg: { id: crypto.randomUUID(), role: "user", text, images, itemIndex } });
    c.items.push(
      images.length
        ? { role: "user", content: [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image" as const, image_url, detail: "auto" as const }))] }
        : { role: "user", content: text },
    );
    emit(c, { t: "assistant", id: crypto.randomUUID(), model: c.meta.model });
    touch(c);

    async function approved(id: string, request: string) {
      if (c.meta.autoApprove && jevEnabled()) {
        emit(c, { t: "tool_status", id, status: "judging" });
        const verdict = await judge(request, cwd, text, signal);
        emit(c, { t: "tool_judge", id, judge: verdict });
        if (verdict.ok) return true;
      }
      const ok = await new Promise<boolean>((resolve) => {
        turn.approvals.set(id, resolve);
        emit(c, { t: "tool_status", id, status: "awaiting" });
      });
      turn.approvals.delete(id);
      return ok;
    }

    async function call({ call_id: id, name, arguments: json }: ResponseFunctionToolCall): Promise<string> {
      const tool = available().find((t) => t.def.name === name);
      const a = parseArgs(json);
      const request = tool?.approval?.(a);
      emit(c, { t: "tool", id, name, args: json, view: { ...(tool?.view(a) ?? { label: name, icon: "terminal", target: "" }), request }, summary: tool?.summary?.(a) });
      try {
        if (!tool) throw new Error(`unknown tool ${name}`);
        if (request !== undefined && !(await approved(id, request))) {
          emit(c, { t: "tool_status", id, status: "denied" });
          return "user denied this command";
        }
        emit(c, { t: "tool_status", id, status: "running" });
        const output = await tool.run(a, { signal, model: c.meta.model });
        emit(c, { t: "tool_status", id, status: "done", output, summary: tool.summary?.(a, output) });
        return output;
      } catch (e) {
        if (signal.aborted) throw e;
        const output = `error: ${(e as Error).message}`;
        emit(c, { t: "tool_status", id, status: "error", output, summary: errorSummary(output) });
        return output;
      }
    }

    try {
      while (true) {
        const calls: ResponseFunctionToolCall[] = [];
        const events = respond({
          model: c.meta.model, effort: c.meta.effort, instructions: instructions(), input: c.items,
          tools: available().map((t) => t.def), session: c.meta.id, signal,
        });
        for await (const ev of events) {
          if (ev.type === "reasoning") emit(c, { t: "reasoning_delta", text: ev.text });
          else if (ev.type === "reasoning_end") emit(c, { t: "reasoning_end" });
          else if (ev.type === "text") emit(c, { t: "text_delta", text: ev.text });
          else {
            c.items.push(ev.item);
            if (ev.item.type === "function_call") calls.push(ev.item as ResponseFunctionToolCall);
          }
        }
        if (!calls.length) break;
        for (const fc of calls) c.items.push({ type: "function_call_output", call_id: fc.call_id, output: await call(fc) });
      }
      emit(c, { t: "end", status: "done" });
    } catch (e) {
      // Drop half-finished tool calls so the history stays valid, but keep what the user already read.
      c.items.length = itemIndex + 1;
      const last = c.messages.at(-1);
      const said = last?.role === "assistant" ? assistantText(last) : "";
      if (said) c.items.push({ role: "assistant", content: said } satisfies ResponseInputItem);
      emit(c, signal.aborted ? { t: "end", status: "stopped" } : { t: "end", status: "error", error: (e as Error).message });
    } finally {
      turns.delete(c.meta.id);
      touch(c);
    }
  }

  return {
    list: () => store.list().map(view),

    open(id: string) {
      const c = load(id);
      return c && { meta: view(c.meta), messages: c.messages, seq: seqs.get(id) ?? 0 };
    },

    create(s: Partial<Settings>): ConvView {
      const c = store.create({ model: s.model ?? defaultModel, effort: s.effort ?? DEFAULTS.effort, autoApprove: s.autoApprove ?? DEFAULTS.autoApprove });
      publish({ type: "meta", meta: view(c.meta) });
      return view(c.meta);
    },

    update(id: string, patch: Partial<Settings & { title: string }>): ConvView | undefined {
      const c = load(id);
      if (!c) return;
      Object.assign(c.meta, patch);
      store.save(c);
      publish({ type: "meta", meta: view(c.meta) });
      return view(c.meta);
    },

    remove(id: string) {
      turns.get(id)?.ctl.abort();
      store.remove(id);
      publish({ type: "deleted", id });
    },

    /** Starts a turn. With `from`, the conversation first rewinds to just before that user message (edit, regenerate). */
    send(id: string, text: string, images: string[], from?: string): "ok" | "missing" | "busy" {
      const c = load(id);
      if (!c) return "missing";
      if (turns.has(id)) return "busy";
      if (from !== undefined) {
        const at = c.messages.findIndex((m) => m.id === from && m.role === "user");
        const m = c.messages[at];
        if (m?.role !== "user") return "missing";
        c.items.length = m.itemIndex;
        emit(c, { t: "truncate", at });
      }
      void runTurn(c, text, images);
      return "ok";
    },

    stop: (id: string) => turns.get(id)?.ctl.abort(),

    approve(id: string, tool: string, ok: boolean): boolean {
      const resolve = turns.get(id)?.approvals.get(tool);
      resolve?.(ok);
      return !!resolve;
    },
  };
}
