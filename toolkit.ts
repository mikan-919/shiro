// What a tool is. Shared by the registry (tools.ts) and the tools defined in their own files (search.ts).
import type { FunctionTool } from "openai/resources/responses/responses";
import type { ToolView } from "./shared";

export type Args = Record<string, unknown>;
/** `model` is the model making the call; services that tune results for it (Parallel) take it. */
export type ToolContext = { signal: AbortSignal; model: string };

/** Everything about one tool: what the model sees, how it runs, and how the UI shows it. */
export type Tool = {
  def: FunctionTool;
  enabled?: () => boolean;
  view: (a: Args) => Omit<ToolView, "request">;
  /** A shell command the user, or Jev on their behalf, must approve before the call runs. Other tools run unattended. */
  command?: (a: Args) => string;
  run: (a: Args, ctx: ToolContext) => Promise<string>;
  /** One line about the call: from its arguments before it runs, from its output once done. */
  summary?: (a: Args, output?: string) => string | undefined;
};

export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
