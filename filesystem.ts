// Read-only local inspection. rg receives fixed argv, never shell source or arbitrary flags.
import { opendir } from "node:fs/promises";
import { def, firstLine, str, type Tool } from "./toolkit";

const OUTPUT_LIMIT = 50_000;
const ENTRY_LIMIT = 1000;
const TIMEOUT_MS = 10_000;

function input(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 4096) {
    throw new Error(`${name} must be a nonempty string (at most 4096 characters, no NUL)`);
  }
  return value;
}

async function runRg(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const rg = Bun.which("rg");
  if (!rg) throw new Error("ripgrep (rg) is required for local search");
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const combined = AbortSignal.any([signal, deadline]);
  const p = Bun.spawn([rg, "--no-config", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: combined });
  let truncated = false;
  const collect = async (stream: ReadableStream<Uint8Array>, limit: number, stop: boolean) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = limit - size;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        size += value.length;
        if (size > limit && stop) {
          truncated = true;
          p.kill();
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  const [out, err, code] = await Promise.all([collect(p.stdout, OUTPUT_LIMIT, true), collect(p.stderr, 4000, false), p.exited]);
  signal.throwIfAborted();
  if (deadline.aborted) throw new Error(`rg search timed out after ${TIMEOUT_MS / 1000}s; narrow the path or pattern`);
  if (truncated) return `${out}\n… (search output truncated at ${OUTPUT_LIMIT} bytes; narrow the path or pattern)`;
  if (code !== 0 && code !== 1) throw new Error(`rg exited ${code}: ${err.trim() || "search failed"}`);
  return (out || "No matches.") + (err ? `\nWarnings:\n${err}` : "");
}

const listDirectory: Tool = {
  def: def("list_directory", "List immediate directory entries (including hidden names), sorted by name, without following symlinks. At most 1000 entries; a capped listing is partial. Read-only; no shell or approval needed.", { path: "Directory path" }),
  view: (a) => ({ label: "一覧", icon: "file", target: str(a.path) }),
  run: async (a, { signal }) => {
    signal.throwIfAborted();
    const dir = await opendir(input(a.path, "path"));
    const entries: string[] = [];
    let truncated = false;
    let bytes = 0;
    for await (const entry of dir) {
      signal.throwIfAborted();
      const name = `${entry.name}${entry.isSymbolicLink() ? "@" : entry.isDirectory() ? "/" : ""}`;
      bytes += Buffer.byteLength(name) + 1;
      if (entries.length >= ENTRY_LIMIT || bytes > OUTPUT_LIMIT) { truncated = true; break; }
      entries.push(name);
    }
    return (entries.sort().join("\n") || "Empty directory.") + (truncated ? "\n… (directory listing truncated)" : "");
  },
  summary: (_, out) => out === undefined ? undefined : firstLine(out),
};

const searchFiles: Tool = {
  def: def("search_files", "Find file paths with ripgrep (rg --files --glob). Pattern is an rg glob, e.g. '*.ts' or '**/package.json'. Uses rg glob semantics: explicit include globs can override ignore/hidden exclusions. Does not follow symlinks. Bounded output and 10s timeout. Read-only; no shell or approval needed.", { path: "File or directory to search", pattern: "File path glob" }),
  view: (a) => ({ label: "ファイル検索", icon: "file", target: str(a.pattern), detail: { kind: "code", text: str(a.path) } }),
  run: (a, { signal }) => runRg(["--files", "--glob", input(a.pattern, "pattern"), "--", input(a.path, "path")], signal),
  summary: (_, out) => out === undefined ? undefined : firstLine(out),
};

const searchText: Tool = {
  def: {
    type: "function", name: "search_text", strict: false,
    description: "Search local file contents with ripgrep. Literal pattern by default; set regex=true for Rust-style regular expressions. Returns path:line:matching text. Optional glob filters files. Respects rg ignore rules and skips hidden files unless an explicit glob/path overrides exclusions. Skips binary files and does not follow symlinks. Files above 2MiB skipped; 200 matches/file, bounded output, 10s timeout. Read-only; no shell or approval needed.",
    parameters: {
      type: "object", properties: {
        path: { type: "string", description: "File or directory to search" },
        pattern: { type: "string", description: "Nonempty literal text (or regex when regex=true)" },
        regex: { type: "boolean", description: "Interpret pattern as a regular expression; default false" },
        glob: { type: "string", description: "Optional rg file glob, e.g. '*.ts'" },
      }, required: ["path", "pattern"], additionalProperties: false,
    },
  },
  view: (a) => ({ label: "内容検索", icon: "file", target: str(a.pattern), detail: { kind: "code", text: str(a.path) } }),
  run: (a, { signal }) => {
    if (a.regex !== undefined && typeof a.regex !== "boolean") throw new Error("regex must be a boolean");
    const args = ["--color", "never", "--line-number", "--with-filename", "--no-heading", "--threads", "2", "--max-filesize", "2M", "--max-count", "200", "--max-columns", "500", "--max-columns-preview"];
    if (!a.regex) args.push("--fixed-strings");
    if (a.glob !== undefined) args.push("--glob", input(a.glob, "glob"));
    args.push("-e", input(a.pattern, "pattern"), "--", input(a.path, "path"));
    return runRg(args, signal);
  },
  summary: (_, out) => out === undefined ? undefined : firstLine(out),
};

export const fileTools: Tool[] = [listDirectory, searchFiles, searchText];
