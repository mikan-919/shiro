// Types and the event reducer shared by the server (persistence) and the browser (rendering).

export const MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
] as const;

export const EFFORTS = [
  { id: "low", name: "速さ優先" },
  { id: "medium", name: "標準" },
  { id: "high", name: "じっくり" },
  { id: "xhigh", name: "最大" },
] as const;
export type Effort = (typeof EFFORTS)[number]["id"];
export const isEffort = (v: unknown): v is Effort => EFFORTS.some((e) => e.id === v);

/** What a new conversation starts with when the user has not chosen otherwise. */
export const DEFAULTS = { effort: "medium" as Effort, autoApprove: true };

export type ToolStatus = "judging" | "running" | "awaiting" | "done" | "denied" | "error";

/** Outcome of automatic approval. by: "rule" = static list, "jev" = TypeSafe Jev, "error" = Jev unavailable. */
export type Judge = { ok: boolean; by: "rule" | "jev" | "error"; reason?: string; readOnly?: number; reversible?: number; servesTask?: number };

/** Icons the browser draws (web/ui.tsx). */
export type ToolIcon = "file" | "pencil" | "terminal" | "search" | "chat";

/** How a tool call is shown. Each tool computes its own on the server, so the browser needs no per-tool code. */
export type ToolView = {
  label: string;
  icon: ToolIcon;
  /** One line naming what the call acts on: a path, a command, a search objective. */
  target: string;
  /** Text the user approves before the call runs. Present only for calls that need approval. */
  request?: string;
  detail?: { kind: "diff"; before: string; after: string } | { kind: "code"; text: string } | { kind: "chips"; items: string[] };
  markdown?: boolean;
};

export type ToolPart = {
  type: "tool";
  id: string;
  name: string;
  args: string;
  view: ToolView;
  status: ToolStatus;
  output?: string;
  /** The gist of the result in one line. */
  summary?: string;
  judge?: Judge;
};
export type ReasoningPart = { type: "reasoning"; text: string; done: boolean };
/** A chat bubble the agent sent with send_message. `reaction` is the user's. */
export type SayPart = { type: "say"; id: string; text: string; reaction?: string };
/** Text the model wrote outside send_message. The user does not receive it; it shows as a note among the steps. */
export type TextPart = { type: "text"; text: string };
export type Part = ReasoningPart | TextPart | ToolPart | SayPart;

/** `reaction` is the agent's, set with its react tool. */
export type UserMessage = { id: string; role: "user"; text: string; images: string[]; itemIndex: number; reaction?: string };
export type AssistantMessage = {
  id: string;
  role: "assistant";
  model: string;
  parts: Part[];
  status: "streaming" | "done" | "stopped" | "error";
  error?: string;
};
export type Message = UserMessage | AssistantMessage;

export type ConvMeta = {
  id: string;
  title: string;
  model: string;
  effort: Effort;
  autoApprove: boolean;
  createdAt: number;
  updatedAt: number;
};
export type Settings = Pick<ConvMeta, "model" | "effort" | "autoApprove">;
export type ConvView = ConvMeta & { running: boolean };

export type Ev =
  | { t: "user"; msg: UserMessage }
  | { t: "assistant"; id: string; model: string }
  | { t: "reasoning_delta"; text: string }
  | { t: "reasoning_end" }
  | { t: "text_delta"; text: string }
  | { t: "tool"; id: string; name: string; args: string; view: ToolView; summary?: string }
  | { t: "tool_status"; id: string; status: ToolStatus; output?: string; summary?: string }
  | { t: "tool_judge"; id: string; judge: Judge }
  | { t: "end"; status: "done" | "stopped" | "error"; error?: string }
  | { t: "truncate"; at: number }
  | { t: "say"; id: string; text: string }
  /** A reaction on a user message (from the agent) or on a bubble (from the user). null removes it. */
  | { t: "react"; target: string; emoji: string | null };

export type Account = { email?: string; plan?: string };

/** Server → browser over the WebSocket. */
export type Push =
  | { type: "ev"; conv: string; seq: number; ev: Ev }
  | { type: "meta"; meta: ConvView }
  | { type: "deleted"; id: string }
  | { type: "auth"; account: Account | null; error?: string };

/** Pure: returns a new array, leaving the input untouched (React state). */
export function apply(msgs: Message[], ev: Ev): Message[] {
  if (ev.t === "user") return [...msgs, ev.msg];
  if (ev.t === "assistant") return [...msgs, { id: ev.id, role: "assistant", model: ev.model, parts: [], status: "streaming" }];
  if (ev.t === "truncate") return msgs.slice(0, ev.at);
  if (ev.t === "react") {
    const reaction = ev.emoji ?? undefined;
    return msgs.map((m): Message => {
      if (m.role === "user") return m.id === ev.target ? { ...m, reaction } : m;
      if (!m.parts.some((p) => p.type === "say" && p.id === ev.target)) return m;
      return { ...m, parts: m.parts.map((p) => (p.type === "say" && p.id === ev.target ? { ...p, reaction } : p)) };
    });
  }

  const last = msgs.at(-1);
  if (last?.role !== "assistant") return msgs;
  const parts = [...last.parts];
  const tail = parts.at(-1);
  switch (ev.t) {
    case "reasoning_delta":
      if (tail?.type === "reasoning" && !tail.done) parts[parts.length - 1] = { ...tail, text: tail.text + ev.text };
      else parts.push({ type: "reasoning", text: ev.text, done: false });
      break;
    case "reasoning_end":
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (p.type === "reasoning" && !p.done) parts[i] = { ...p, done: true };
      }
      break;
    case "text_delta":
      if (tail?.type === "text") parts[parts.length - 1] = { ...tail, text: tail.text + ev.text };
      else parts.push({ type: "text", text: ev.text });
      break;
    case "say":
      parts.push({ type: "say", id: ev.id, text: ev.text });
      break;
    case "tool":
      parts.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args, view: ev.view, summary: ev.summary, status: "running" });
      break;
    case "tool_status":
    case "tool_judge": {
      const i = parts.findIndex((p) => p.type === "tool" && p.id === ev.id);
      const p = parts[i] as ToolPart | undefined;
      if (!p) break;
      parts[i] = ev.t === "tool_judge" ? { ...p, judge: ev.judge } : { ...p, status: ev.status, output: ev.output, summary: ev.summary ?? p.summary };
      break;
    }
    case "end": {
      // Nothing can still be in flight once the turn has ended.
      const closed = parts.map((p): Part => {
        if (p.type === "reasoning" && !p.done) return { ...p, done: true };
        if (p.type === "tool" && (p.status === "awaiting" || p.status === "judging")) return { ...p, status: "denied" };
        if (p.type === "tool" && p.status === "running") return { ...p, status: "error", output: p.output ?? "中断されました" };
        return p;
      });
      return [...msgs.slice(0, -1), { ...last, parts: closed, status: ev.status, error: ev.error }];
    }
  }
  return [...msgs.slice(0, -1), { ...last, parts }];
}

/** What the agent said to the user in a message: its bubbles. Text written outside send_message is never shown. */
export const assistantText = (m: AssistantMessage) => m.parts.flatMap((p) => (p.type === "say" ? [p.text] : [])).join("\n\n");
