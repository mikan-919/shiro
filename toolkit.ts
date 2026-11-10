// What a tool is. Shared by the registry (tools.ts) and the tools defined in their own files (search.ts, chat.ts).
import type { FunctionTool } from "openai/resources/responses/responses";
import type { ToolView } from "./shared";

export type Args = Record<string, unknown>;
export type ToolContext = {
  team?: { act(action: string, id: string, text: string): string };
  signal: AbortSignal;
  /** The model making the call; services that tune results for it (Parallel) take it. */
  model: string;
  /** The conversation the call belongs to. */
  chat: {
    /** Shows a chat bubble to the user. */
    say(text: string): void;
    /** Reacts to the user message with this short id; false when there is none. null removes the reaction. */
    react(messageId: string, emoji: string | null): boolean;
  };
};

/** Everything about one tool: what the model sees, how it runs, and how the UI shows it. */
export type Tool = {
  def: FunctionTool;
  enabled?: () => boolean;
  /** The call shows only through its own effect (a bubble, a reaction), not as a step. */
  silent?: boolean;
  view: (a: Args) => Omit<ToolView, "request">;
  /** A shell command the user, or Jev on their behalf, must approve before the call runs. Other tools run unattended. */
  command?: (a: Args) => string;
  run: (a: Args, ctx: ToolContext) => Promise<string>;
  /** One line about the call: from its arguments before it runs, from its output once done. */
  summary?: (a: Args, output?: string) => string | undefined;
};

/** A strict function definition whose parameters are all required strings. */
export const def = (name: string, description: string, props: Record<string, string>): FunctionTool => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: {
    type: "object",
    properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: "string", description: d }])),
    required: Object.keys(props),
    additionalProperties: false,
  },
});

export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
