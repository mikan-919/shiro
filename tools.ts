import type { FunctionTool } from "openai/resources/responses/responses";
import type { ToolStatus, ToolView } from "./shared";
import { firstLine, str, type Args, type Tool } from "./toolkit";
import { searchTool } from "./search";

const lineCount = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);

const def = (name: string, description: string, props: Record<string, string>): FunctionTool => ({
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

// Keeps one huge file or log from filling the context window.
const LIMIT = 50_000;
const cap = (s: string) => (s.length > LIMIT ? `${s.slice(0, LIMIT)}\n… (${s.length - LIMIT} chars truncated)` : s);

const readFile: Tool = {
  def: def("read_file", "Read a text file.", { path: "File path" }),
  view: (a) => ({ label: "読み込み", icon: "file", target: str(a.path) }),
  run: async (a) => cap(await Bun.file(str(a.path)).text()),
  summary: (_, out) => (out === undefined ? undefined : firstLine(out) || "空のファイル"),
};

const writeFile: Tool = {
  def: def("write_file", "Create or overwrite a file.", { path: "File path", content: "Full file content" }),
  view: (a) => ({ label: "書き込み", icon: "file", target: str(a.path), detail: { kind: "code", text: str(a.content) } }),
  run: async (a) => {
    await Bun.write(str(a.path), str(a.content));
    return `wrote ${str(a.path)}`;
  },
  summary: (a) => firstLine(str(a.content)) || "空のファイル",
};

const editFile: Tool = {
  def: def("edit_file", "Replace one exact, unique occurrence of old_str with new_str.", {
    path: "File path", old_str: "Exact text to replace", new_str: "Replacement text",
  }),
  view: (a) => ({ label: "編集", icon: "pencil", target: str(a.path), detail: { kind: "diff", before: str(a.old_str), after: str(a.new_str) } }),
  run: async (a) => {
    const [path, from, to] = [str(a.path), str(a.old_str), str(a.new_str)];
    const text = await Bun.file(path).text();
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`old_str matched ${n} times, need exactly 1`);
    await Bun.write(path, text.replace(from, () => to));
    return `edited ${path}`;
  },
  summary: (a) => `−${lineCount(str(a.old_str))} +${lineCount(str(a.new_str))}  ${firstLine(str(a.new_str))}`,
};

// The model reads bash output as "exit <code>\n<stdout><stderr>"; summary() reads the same shape back.
const bash: Tool = {
  def: def("bash", "Run a shell command in the current directory. The user approves each call.", { command: "Command" }),
  view: (a) => ({ label: "コマンド", icon: "terminal", target: firstLine(str(a.command)), detail: { kind: "code", text: `$ ${str(a.command)}` } }),
  command: (a) => str(a.command),
  run: async (a, { signal }) => {
    const p = Bun.spawn(["bash", "-c", str(a.command)], { stdout: "pipe", stderr: "pipe", signal });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return cap(`exit ${code}\n${out}${err}`);
  },
  summary: (_, out) => {
    if (out === undefined) return undefined;
    const [, code = "0", rest = ""] = /^exit (\S+)\n?([\s\S]*)$/.exec(out) ?? [];
    const line = firstLine(rest);
    return code === "0" ? line || "出力なし" : `終了コード ${code}${line ? `: ${line}` : ""}`;
  },
};

const ALL = [readFile, writeFile, editFile, bash, searchTool];

const enabled = (t: Tool) => t.enabled?.() ?? true;
export const available = () => ALL.filter(enabled);
/** The tool a call may run, or undefined for one that is disabled or does not exist. */
export const usable = (name: string) => ALL.find((t) => t.def.name === name && enabled(t));

/** How a call looks. Works for any name, so calls to tools since disabled or never defined still show. */
export function describe(name: string, a: Args): ToolView {
  const tool = ALL.find((t) => t.def.name === name);
  return { ...(tool?.view(a) ?? { label: name, icon: "terminal", target: "" }), request: tool?.command?.(a) };
}

const ERROR = "error: ";
/** What the model reads when a call fails. summarize() reads the message back from the same prefix. */
export const errorOutput = (message: string) => ERROR + message;

export function summarize(name: string, a: Args, status: ToolStatus, output?: string): string | undefined {
  if (status === "error") return firstLine(output?.startsWith(ERROR) ? output.slice(ERROR.length) : (output ?? ""));
  return ALL.find((t) => t.def.name === name)?.summary?.(a, status === "done" ? output : undefined);
}

/** The arguments of a call, or undefined when the model sent something other than a JSON object. */
export function parseArgs(json: string): Args | undefined {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
