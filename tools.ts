import type { ToolStatus, ToolView } from "./shared";
import { def, firstLine, str, toolDeclaration, type Args, type Tool } from "./toolkit";
import { codeModeEnabled, executeCode } from "./codemode";
import { react, sendMessage } from "./chat";
import { gapTool, settleTool, teamTool, writeGistTool } from "./team";
import { searchTool } from "./search";
import { fetchTool } from "./fetch";
import { fileTools } from "./filesystem";
import { open } from "node:fs/promises";
import { constants } from "node:fs";

const lineCount = (s: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);

// Keeps one huge file or log from filling the context window.
const LIMIT = 50_000;
const cap = (s: string) => (s.length > LIMIT ? `${s.slice(0, LIMIT)}\n… (${s.length - LIMIT} chars truncated)` : s);

const readFile: Tool = {
  def: {
    type: "function", name: "read_file", strict: false,
    description: "Read a UTF-8 text file, optionally selecting inclusive 1-based start_line/end_line. Returns original text without added line numbers. Output capped at 50,000 characters; scans at most 8MiB, reporting truncation. Read-only; no shell or approval needed.",
    parameters: {
      type: "object", properties: {
        path: { type: "string", description: "File path" },
        start_line: { type: "integer", description: "First line, inclusive, starting at 1; default 1" },
        end_line: { type: "integer", description: "Last line, inclusive; default end of file" },
      }, required: ["path"], additionalProperties: false,
    },
  },
  view: (a) => ({ label: "読み込み", icon: "file", target: str(a.path) }),
  run: async (a, { signal }) => {
    const rawStart = a.start_line ?? 1, rawEnd = a.end_line ?? Infinity;
    if (typeof rawStart !== "number" || !Number.isSafeInteger(rawStart) || rawStart < 1) throw new Error("start_line must be a positive safe integer");
    if (typeof rawEnd !== "number" || (a.end_line !== undefined && !Number.isSafeInteger(rawEnd)) || rawEnd < rawStart) throw new Error("end_line must be a safe integer >= start_line");
    const start: number = rawStart, end: number = rawEnd;
    signal.throwIfAborted();
    // Nonblocking open prevents a named pipe from hanging before the regular-file check.
    const file = await open(str(a.path), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("read_file requires a regular file");
      const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder();
      const scanLimit = 8 * 1024 * 1024;
      let scanned = 0, line = 1, output = "";
      function consume(text: string): string | undefined {
        let offset = 0;
        while (offset < text.length) {
          const newline = text.indexOf("\n", offset);
          const next = newline < 0 ? text.length : newline + 1;
          if (line >= start) {
            const part = text.slice(offset, next);
            if (output.length + part.length > LIMIT) return output + part.slice(0, LIMIT - output.length) + "\n… (output truncated at 50,000 characters)";
            output += part;
          }
          if (newline >= 0 && line++ >= end) return output;
          offset = next;
        }
      }
      while (scanned < scanLimit) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, scanLimit - scanned), null);
        if (!bytesRead) return consume(decoder.decode()) ?? output;
        scanned += bytesRead;
        const result = consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
        if (result !== undefined) return result;
      }
      return consume(decoder.decode()) ?? (output + "\n… (scan truncated at 8MiB; requested range may be incomplete)");
    } finally { await file.close(); }
  },
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

const executeCodeTool: Tool = {
  get def() {
    return def("execute_code",
      "Run JavaScript in an isolated local sandbox to combine tool calls, loops, filtering and parallel reads in one model turn. " +
      "Pass an async function expression, e.g. async () => { const text = await tools.read_file({path: 'README.md'}); return text.slice(0, 500); }. " +
      "Return only what you need: the return value and console logs are sent back. Tool results are strings (failures start with 'error: '). " +
      "Only the tools API below is available for host access; no direct filesystem, network, environment or process access. " +
      "Each inner tool call retains normal approval, UI, cancellation and side-effect ordering. execute_code cannot call itself. " +
      "Use plain JavaScript, not TypeScript. The following declarations document tools:\n" +
      "declare const tools: {\n" + ALL.filter((t) => t !== executeCodeTool && enabled(t)).map(toolDeclaration).join("\n") + "\n};",
      { code: "An async JavaScript function expression to execute, using await tools.<name>({...})" });
  },
  enabled: codeModeEnabled,
  view: (a) => ({ label: "コード実行", icon: "terminal", target: firstLine(str(a.code)), detail: { kind: "code", text: str(a.code) } }),
  run: async (a, ctx) => {
    if (!ctx.callTool) throw new Error("Code Mode requires the tool runner");
    return executeCode(str(a.code), ctx.callTool, ctx.signal);
  },
  summary: (_, out) => out === undefined ? undefined : firstLine(out),
};

const ALL = [sendMessage, react, readFile, ...fileTools, writeFile, editFile, bash, searchTool, fetchTool, teamTool, gapTool, settleTool, writeGistTool, executeCodeTool];

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
