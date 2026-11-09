import type { FunctionTool } from "openai/resources/responses/responses";
import { SEARCH_TOOL, searchEnabled, webSearch } from "./search";

const tool = (name: string, description: string, props: Record<string, string>): FunctionTool => ({
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

const BASE = [
  tool("read_file", "Read a text file.", { path: "File path" }),
  tool("write_file", "Create or overwrite a file.", { path: "File path", content: "Full file content" }),
  tool("edit_file", "Replace one exact, unique occurrence of old_str with new_str.", {
    path: "File path", old_str: "Exact text to replace", new_str: "Replacement text",
  }),
  tool("bash", "Run a shell command in the current directory. The user approves each call.", { command: "Command" }),
];

/** Web search is offered only when a Parallel API key is configured. */
export const tools = () => (searchEnabled() ? [...BASE, SEARCH_TOOL] : BASE);

// Keeps one huge file or log from filling the context window.
const LIMIT = 50_000;
const cap = (s: string) => (s.length > LIMIT ? `${s.slice(0, LIMIT)}\n… (${s.length - LIMIT} chars truncated)` : s);

export async function runTool(
  name: string,
  a: Record<string, any>,
  confirm: (command: string) => Promise<boolean>,
  signal?: AbortSignal,
  model = "",
): Promise<string> {
  switch (name) {
    case "web_search":
      if (!searchEnabled()) throw new Error("web search is not configured");
      return webSearch(String(a.objective ?? ""), Array.isArray(a.search_queries) ? a.search_queries.map(String) : [], model, signal);
    case "read_file":
      return cap(await Bun.file(a.path!).text());
    case "write_file":
      await Bun.write(a.path!, a.content!);
      return `wrote ${a.path}`;
    case "edit_file": {
      const text = await Bun.file(a.path!).text();
      const n = text.split(a.old_str!).length - 1;
      if (n !== 1) throw new Error(`old_str matched ${n} times, need exactly 1`);
      await Bun.write(a.path!, text.replace(a.old_str!, () => a.new_str!));
      return `edited ${a.path}`;
    }
    case "bash": {
      if (!(await confirm(a.command!))) return "user denied this command";
      const p = Bun.spawn(["bash", "-c", a.command!], { stdout: "pipe", stderr: "pipe", signal });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return cap(`exit ${code}\n${out}${err}`);
    }
  }
  throw new Error(`unknown tool ${name}`);
}
