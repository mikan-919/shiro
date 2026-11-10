// The conversation runtime: turns, approvals and the event stream every open tab follows.
import type { ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import * as store from "./store";
import { createBoard } from "./team";
import { respond } from "./codex";
import { available, describe, parseArgs, summarize } from "./tools";
import { firstLine } from "./toolkit";
import { instructions, teamInstructions } from "./instructions";
import { createToolRunner } from "./tool-runner";
import { apply, DEFAULTS, type ConvMeta, type ConvView, type Ev, type Message, type Part, type Push, type Settings, type ToolPart } from "./shared";

type Turn = { ctl: AbortController; approvals: Map<string, (ok: boolean) => void>; deleted?: boolean };

/** The id the model sees for a user message: short enough to quote back to the react tool. */
const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);

/** Fills in the view of a tool call stored before calls carried one. */
function withView(p: ToolPart): ToolPart {
  if (p.view) return p;
  const a = parseArgs(p.args) ?? {};
  return { ...p, view: describe(p.name, a), summary: summarize(p.name, a, p.status, p.output) };
}

export function createAgent({ publish, cwd, defaultModel, response = respond }: { response?: typeof respond; publish: (p: Push) => void; cwd: string; defaultModel: string }) {
  const turns = new Map<string, Turn>();
  const seqs = new Map<string, number>();
  // ponytail: in memory, so reactions made just before a restart are not told to the model; persist if that matters
  const notes = new Map<string, string[]>();

  const view = (m: ConvMeta): ConvView => ({ ...m, running: turns.has(m.id) });

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
    if (c.board?.statuses) for (const [agent, status] of Object.entries(c.board.statuses)) if (status === "running") c.board.statuses[agent] = "stopped";
    for (const m of c.messages) if (m.role === "assistant" && m.status === "streaming") c.messages = apply(c.messages, { t: "end", message: m.id, status: "stopped" });
    c.messages = c.messages.map((m): Message =>
      m.role === "assistant" ? { ...m, parts: m.parts.map((p): Part => (p.type === "tool" ? withView(p) : p)) } : m,
    );
    return c;
  }

  /** `rewound`: the turn replaces an earlier one (edit, regenerate), so the conversation already has its title. */
  async function runTurn(c: store.Conv, text: string, images: string[], rewound: boolean) {
    const turn: Turn = { ctl: new AbortController(), approvals: new Map() };
    const { signal } = turn.ctl;
    turns.set(c.meta.id, turn);
    // Stopping while a call waits for approval counts as a denial; the next request then sees the abort.
    signal.addEventListener("abort", () => turn.approvals.forEach((resolve) => resolve(false)));
    const itemIndex = c.items.length;
    if (!c.messages.length && !rewound) c.meta.title = text.replace(/\s+/g, " ").trim().slice(0, 40) || "画像";
    const userId = crypto.randomUUID();
    emit(c, { t: "user", msg: { id: userId, role: "user", text, images, itemIndex } });
    // The model sees the message id (to react to it) and what the user did since its last turn.
    const userText = [...(notes.get(c.meta.id) ?? []), `[#${shortId(userId)}] ${text}`].join("\n");
    notes.delete(c.meta.id);
    c.items.push(
      images.length
        ? { role: "user", content: [{ type: "input_text", text: userText }, ...images.map((image_url) => ({ type: "input_image" as const, image_url, detail: "auto" as const }))] }
        : { role: "user", content: userText },
    );
    const statuses: Record<string, string> = { "shiro-1": "running", "shiro-2": "running" };
    const board = createBoard(undefined, () => {
      if (!turn.deleted) { store.save(c); broadcastBoard(); }
    });
    const broadcastBoard = () => emit(c, { t: "board", board: structuredClone(board.state) });
    board.state.statuses = statuses;
    c.board = board.state;
    board.state.tasks.push(
      { id: "investigate", text: "Investigate the request and propose an approach; publish findings and add concrete subtasks if useful.", done: false },
      { id: "independent-check", text: "Independently check the request, risks and evidence; verify peer work and contribute a complementary result.", done: false },
    );
    broadcastBoard();
    touch(c);
    const base = structuredClone(c.items);
    // Shared workspace: serialize side effects, including arbitrary shell commands.
    let effects = Promise.resolve();
    async function exclusive<T>(f: () => Promise<T>): Promise<T> {
      const prev = effects;
      let release!: () => void;
      effects = new Promise<void>((r) => { release = r; });
      await prev;
      try { signal.throwIfAborted(); return await f(); } finally { release(); }
    }

    async function worker(agent: string) {
      const message = crypto.randomUUID();
      const history = structuredClone(base);
      const workerEmit = (ev: Ev) => { if (!turn.deleted) emit(c, { ...ev, message }); };
      workerEmit({ t: "assistant", id: message, model: c.meta.model, agent });
      const team = board.forAgent(agent);

      const chat = {
        say(text: string) {
          signal.throwIfAborted();
          const id = crypto.randomUUID();
          // Each bubble is appended when sent, preserving interleaved group-chat order.
          emit(c, { t: "assistant", id, model: c.meta.model, agent });
          emit(c, { t: "say", message: id, id: crypto.randomUUID(), text });
          emit(c, { t: "end", message: id, status: "done" });
          c.items.push({ role: "assistant", content: `[${agent}] ${text}` });
          team.act("publish", "", `Chat: ${text}`);
        },
        react(messageId: string, emoji: string | null) {
          const m = c.messages.find((x) => x.role === "user" && shortId(x.id) === messageId);
          if (m) workerEmit({ t: "react", target: m.id, emoji });
          return !!m;
        },
      };

      const call = createToolRunner({
        message, signal, emit: workerEmit, chat, team, settings: () => c.meta,
        approvals: turn.approvals, cwd, task: text, exclusive,
      });

      try {
        for (let round = 0; ; round++) {
          signal.throwIfAborted();
          if (round >= 40) throw new Error("チームの実行上限（40ラウンド）に達しました");
          const calls: ResponseFunctionToolCall[] = [];
          const events = response({
            model: c.meta.model, effort: c.meta.effort, instructions: instructions(cwd) + teamInstructions(agent, board.snapshot(), statuses), input: history,
            tools: available().map((t) => t.def), session: `${c.meta.id}:${agent}`, signal,
          });
          for await (const ev of events) {
            signal.throwIfAborted();
            if (ev.type === "reasoning") workerEmit({ t: "reasoning_delta", text: ev.text });
            else if (ev.type === "reasoning_end") workerEmit({ t: "reasoning_end" });
            else if (ev.type === "text") workerEmit({ t: "text_delta", text: ev.text });
            else {
              history.push(ev.item);
              if (ev.item.type === "function_call") calls.push(ev.item as ResponseFunctionToolCall);
            }
          }
          if (!calls.length) break;
          for (const fc of calls) history.push({ type: "function_call_output", call_id: fc.call_id, output: await call(fc) });
        }
        signal.throwIfAborted();
        workerEmit({ t: "end", status: "done" });
      } catch (e) {
        statuses[agent] = signal.aborted ? "stopped" : "error";
        workerEmit(signal.aborted ? { t: "end", status: "stopped" } : { t: "end", status: "error", error: (e as Error).message });
      } finally {
        if (statuses[agent] === "running") statuses[agent] = "finished";
        for (const task of board.state.tasks) if (task.owner === agent && !task.done) delete task.owner;
        if (!turn.deleted) { store.save(c); broadcastBoard(); }
      }
    }
    try {
      await Promise.allSettled([worker("shiro-1"), worker("shiro-2")]);
    } finally {
      turns.delete(c.meta.id);
      if (!turn.deleted) {
        const findings = board.state.notes.filter((n) => !n.text.startsWith("Chat: "));
        if (findings.length) c.items.push({ role: "assistant", content: `Team findings (reported by peers; verify before reuse): ${JSON.stringify(findings)}` });
        touch(c);
      }
    }
  }

  return {
    list: () => store.list().map(view),

    open(id: string) {
      const c = load(id);
      return c && { meta: view(c.meta), messages: c.messages, board: c.board ?? { tasks: [], notes: [] }, seq: seqs.get(id) ?? 0 };
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
      const turn = turns.get(id);
      if (turn) { turn.deleted = true; turn.ctl.abort(); }
      seqs.delete(id);
      notes.delete(id);
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
      void runTurn(c, text, images, from !== undefined);
      return "ok";
    },

    stop: (id: string) => turns.get(id)?.ctl.abort(),

    /** The user reacting to one of the agent's bubbles. The model hears about it with the next message. */
    react(id: string, target: string, emoji: string | null): boolean {
      const c = load(id);
      const bubble = c?.messages.flatMap((m) => (m.role === "assistant" ? m.parts : [])).find((p) => p.type === "say" && p.id === target);
      if (!c || bubble?.type !== "say") return false;
      emit(c, { t: "react", target, emoji });
      store.save(c);
      const quote = firstLine(bubble.text).slice(0, 40);
      const note = emoji ? `(ユーザーがあなたのメッセージ「${quote}」に ${emoji} でリアクションしました)` : `(ユーザーがあなたのメッセージ「${quote}」へのリアクションを取り消しました)`;
      notes.set(id, [...(notes.get(id) ?? []), note]);
      return true;
    },

    approve(id: string, call: string, ok: boolean): boolean {
      const resolve = turns.get(id)?.approvals.get(call);
      resolve?.(ok);
      return !!resolve;
    },
  };
}
