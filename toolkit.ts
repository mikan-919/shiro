// What a tool is. Shared by the registry (tools.ts) and the tools defined in their own files (search.ts, chat.ts).
import type { FunctionTool } from "openai/resources/responses/responses";
import type { ToolView } from "./shared";

export type Args = Record<string, unknown>;
export type ToolContext = {
  team?: { act(action: string, id: string, text: string): string };
  /** Typed gists beyond notes and tasks. `append` returns the new gist's number; `settled` is the long-term shared context. */
  substrate?: { append(kind: string, body: unknown): number; settled(): { seq: number }[]; cwd: string };
  signal: AbortSignal;
  /** Dispatch through the runner, never directly through a tool's run method. */
  callTool?: (name: string, args: Args, signal?: AbortSignal) => Promise<string>;
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

/** Validate the schema subset used by our tools; unsupported schemas fail closed. */
export function validateArgs(tool: Tool, args: Args): void {
  function check(schema: unknown, value: unknown, path: string): void {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`unsupported schema at ${path}`);
    const s = schema as Record<string, unknown>;
    if (Array.isArray(s.enum) && !s.enum.includes(value)) throw new Error(`${path} is not an allowed value`);
    switch (s.type) {
      case "string":
        if (typeof value !== "string") throw new Error(`${path} must be a string`);
        break;
      case "boolean":
        if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
        break;
      case "number": case "integer":
        if (typeof value !== "number" || !Number.isFinite(value) || (s.type === "integer" && !Number.isInteger(value))) throw new Error(`${path} must be a ${s.type}`);
        break;
      case "array":
        if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
        value.forEach((v, i) => check(s.items, v, `${path}[${i}]`));
        break;
      case "object": {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
        const obj = value as Args;
        const props = (s.properties ?? {}) as Record<string, unknown>;
        for (const key of (s.required ?? []) as string[]) {
          if (!Object.hasOwn(obj, key)) throw new Error(`${path}.${key} is required`);
        }
        for (const [key, v] of Object.entries(obj)) {
          if (Object.hasOwn(props, key)) check(props[key], v, `${path}.${key}`);
          else if (s.additionalProperties === false) throw new Error(`${path}.${key} is not allowed`);
          else if (s.additionalProperties && typeof s.additionalProperties === "object") check(s.additionalProperties, v, `${path}.${key}`);
        }
        break;
      }
      default: throw new Error(`unsupported schema type at ${path}`);
    }
  }
  check(tool.def.parameters, args, "arguments");
}

/** TypeScript-like declarations for the isolated JavaScript tool API (not executable TS). */
export function toolDeclaration(tool: Tool): string {
  function type(schema: unknown): string {
    const s = (schema ?? {}) as Record<string, unknown>;
    if (s.type === "array") return `Array<${type(s.items)}>`;
    if (s.type === "object") {
      const required = (s.required ?? []) as string[];
      return `{ ${Object.entries((s.properties ?? {}) as Args).map(([k, v]) => `${JSON.stringify(k)}${required.includes(k) ? "" : "?"}: ${type(v)}`).join("; ")} }`;
    }
    if (s.type === "integer") return "number";
    return ["string", "number", "boolean"].includes(String(s.type)) ? String(s.type) : "unknown";
  }
  return `${JSON.stringify(tool.def.name)}: (args: ${type(tool.def.parameters)}) => Promise<string>; // ${tool.def.description ?? ""}`;
}

export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
