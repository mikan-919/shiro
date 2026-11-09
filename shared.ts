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

export type ToolStatus = "running" | "awaiting" | "done" | "denied" | "error";

export type Part =
  | { type: "reasoning"; text: string; done: boolean }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: string; status: ToolStatus; output?: string };

export type UserMessage = { id: string; role: "user"; text: string; images: string[]; itemIndex: number };
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
  createdAt: number;
  updatedAt: number;
  running: boolean;
};

export type Ev =
  | { t: "user"; msg: UserMessage }
  | { t: "assistant"; id: string; model: string }
  | { t: "reasoning_delta"; text: string }
  | { t: "reasoning_end" }
  | { t: "text_delta"; text: string }
  | { t: "tool"; id: string; name: string; args: string }
  | { t: "tool_status"; id: string; status: ToolStatus; output?: string }
  | { t: "end"; status: "done" | "stopped" | "error"; error?: string }
  | { t: "truncate"; at: number };

/** Server → browser over the WebSocket. */
export type Push =
  | { type: "ev"; conv: string; seq: number; ev: Ev }
  | { type: "meta"; meta: ConvMeta }
  | { type: "deleted"; id: string }
  | { type: "auth"; account: Account | null };

export type Account = { email?: string; plan?: string };

/** Pure: returns a new array, leaving the input untouched (React state). */
export function apply(msgs: Message[], ev: Ev): Message[] {
  if (ev.t === "user") return [...msgs, ev.msg];
  if (ev.t === "assistant") return [...msgs, { id: ev.id, role: "assistant", model: ev.model, parts: [], status: "streaming" }];
  if (ev.t === "truncate") return msgs.slice(0, ev.at);

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
    case "tool":
      parts.push({ type: "tool", id: ev.id, name: ev.name, args: ev.args, status: "running" });
      break;
    case "tool_status": {
      const i = parts.findIndex((p) => p.type === "tool" && p.id === ev.id);
      if (i >= 0) parts[i] = { ...(parts[i] as Extract<Part, { type: "tool" }>), status: ev.status, output: ev.output };
      break;
    }
    case "end": {
      // Nothing can still be in flight once the turn has ended.
      const closed = parts.map((p): Part => {
        if (p.type === "reasoning" && !p.done) return { ...p, done: true };
        if (p.type === "tool" && p.status === "awaiting") return { ...p, status: "denied" };
        if (p.type === "tool" && p.status === "running") return { ...p, status: "error", output: p.output ?? "中断されました" };
        return p;
      });
      return [...msgs.slice(0, -1), { ...last, parts: closed, status: ev.status, error: ev.error }];
    }
  }
  return [...msgs.slice(0, -1), { ...last, parts }];
}

/** Text the assistant produced in a message, used to keep context when a turn is cut short. */
export const assistantText = (m: AssistantMessage) =>
  m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
