import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools } from "./filesystem";
import { validateArgs, type ToolContext } from "./toolkit";
import { createToolRunner } from "./tool-runner";
import { available, usable } from "./tools";
import { codeModeEnabled } from "./codemode";

const root = await mkdtemp(join(tmpdir(), "shiro-files-"));
const dir = join(root, "project");
await mkdir(dir);
await mkdir(join(dir, ".git"));
await mkdir(join(dir, "sub"));
await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
await writeFile(join(dir, "alpha.ts"), "literal a|b > c\nsecond line\n");
await writeFile(join(dir, "sub", "beta.ts"), "alpha123\n");
await writeFile(join(dir, "ignored.txt"), "alpha123\n");
await writeFile(join(dir, ".hidden"), "alpha123\n");
await writeFile(join(dir, "binary.dat"), Buffer.from("\0alpha123\0"));
await writeFile(join(root, "outside.txt"), "outside-only\n");
await symlink(join(root, "outside.txt"), join(dir, "link"));
afterAll(() => rm(root, { recursive: true, force: true }));
const ctx = (signal = new AbortController().signal): ToolContext => ({ signal, model: "test", chat: { say() {}, react: () => true } });
async function run(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const tool = fileTools.find((t) => t.def.name === name)!;
  validateArgs(tool, args);
  return tool.run(args, ctx(signal));
}

test("directory listing includes hidden names and marks directories/symlinks", async () => {
  const lines = (await run("list_directory", { path: dir })).split("\n");
  expect(lines).toContain(".hidden");
  expect(lines).toContain("sub/");
  expect(lines).toContain("link@");
  expect(lines).toEqual([...lines].sort());
  expect(fileTools.every((t) => !t.command)).toBe(true);
});

test("rg file globs recurse and explicit include globs override ignore/hidden rules", async () => {
  const ts = await run("search_files", { path: dir, pattern: "*.ts" });
  expect(ts).toContain("alpha.ts");
  expect(ts).toContain("sub/beta.ts");
  const all = await run("search_files", { path: dir, pattern: "*" });
  expect(all).toContain("ignored.txt");
  expect(all).toContain(".hidden");
  expect(all).not.toContain("link");
  expect(await run("search_files", { path: dir, pattern: "*.missing" })).toBe("No matches.");
});

test("rg text search is literal by default and supports explicit regex/glob", async () => {
  const literal = await run("search_text", { path: dir, pattern: "a|b > c" });
  expect(literal).toContain("alpha.ts:1:literal a|b > c");
  expect(literal).not.toContain("beta.ts");
  expect(await run("search_text", { path: dir, pattern: "alpha[0-9]+" })).toBe("No matches.");
  const regex = await run("search_text", { path: dir, pattern: "alpha[0-9]+", regex: true, glob: "*.ts" });
  expect(regex).toContain("beta.ts:1:alpha123");
  expect(regex).not.toContain("ignored.txt");
  expect(regex).not.toContain(".hidden");
  expect(regex).not.toContain("binary.dat");
  expect(await run("search_text", { path: dir, pattern: "outside-only" })).toBe("No matches.");
});

test("rg does not interpret patterns as flags or shell code", async () => {
  const name = "$(touch should-not-exist); --help.txt";
  await writeFile(join(dir, name), "--help\n");
  expect(await run("search_text", { path: dir, pattern: "--help" })).toContain(":1:--help");
  expect(await run("search_files", { path: dir, pattern: name })).toContain(name);
  expect(await Bun.file("should-not-exist").exists()).toBe(false);
});

test("search rejects invalid regex/path/arguments and respects cancellation", async () => {
  await expect(run("search_text", { path: dir, pattern: "[", regex: true })).rejects.toThrow("rg exited 2");
  await expect(run("search_files", { path: join(root, "missing"), pattern: "*" })).rejects.toThrow("rg exited 2");
  await expect(run("search_text", { path: dir, pattern: "" })).rejects.toThrow("nonempty");
  await expect(run("search_text", { path: dir, pattern: "x", regex: "true" })).rejects.toThrow("boolean");
  await expect(run("search_files", { path: dir, pattern: "*", flags: "--pre=evil" })).rejects.toThrow("not allowed");
  const ctl = new AbortController(); ctl.abort();
  for (const name of ["search_text", "search_files", "list_directory"]) {
    await expect(run(name, name === "list_directory" ? { path: dir } : { path: dir, pattern: "x" }, ctl.signal)).rejects.toThrow();
  }
});

test("large/binary files skipped, long search output capped, directory listing bounded", async () => {
  const big = join(root, "big.txt");
  await writeFile(big, "needle\n" + "x".repeat(2 * 1024 * 1024));
  expect(await run("search_text", { path: root, glob: "big.txt", pattern: "needle" })).toBe("No matches.");
  const many = join(root, "many"); await mkdir(many);
  await Promise.all(Array.from({ length: 1010 }, (_, n) => writeFile(join(many, `${n}.txt`), "hit " + "x".repeat(200))));
  const listing = await run("list_directory", { path: many });
  expect(listing.split("\n")).toHaveLength(1001);
  expect(listing).toContain("listing truncated");
  const results = await run("search_text", { path: many, pattern: "hit" });
  expect(results).toContain("search output truncated");
  expect(Buffer.byteLength(results)).toBeLessThan(50200);
});

function runner(fullAccess = false) {
  const approvals = new Map<string, (ok: boolean) => void>();
  const statuses: string[] = [];
  const call = createToolRunner({
    message: "files-test", signal: new AbortController().signal,
    emit: (e) => { if (e.t === "tool_status") statuses.push(e.status); },
    chat: ctx().chat, team: undefined,
    settings: () => ({ model: "test", autoApprove: false, fullAccess }), approvals,
    cwd: dir, task: "Inspect project files", exclusive: (f) => f(),
  });
  return { approvals, statuses, call: (name: string, args: object) => call({ type: "function_call", name, call_id: crypto.randomUUID(), arguments: JSON.stringify(args) }) };
}

test("registered read-only tools execute through runner without approval", async () => {
  const r = runner();
  for (const name of ["list_directory", "search_files", "search_text"]) {
    expect(available().some((t) => t.def.name === name)).toBe(true);
    const args = name === "list_directory" ? { path: dir } : { path: dir, pattern: name === "search_files" ? "*.ts" : "second line" };
    const output = await r.call(name, args);
    expect(output).toContain("alpha.ts");
    expect(output).not.toStartWith("error: ");
  }
  expect(r.approvals.size).toBe(0);
  expect(r.statuses).not.toContain("awaiting");
  expect(r.statuses).not.toContain("judging");
});

(codeModeEnabled() ? test : test.skip)("Code Mode exposes new tools and combines rg search with file reads", async () => {
  const declaration = usable("execute_code")!.def.description!;
  for (const name of ["list_directory", "search_files", "search_text"]) expect(declaration).toContain(`"${name}"`);
  const r = runner();
  const result = JSON.parse(await r.call("execute_code", { code: `async () => {
    const matches = await tools.search_text({path: ${JSON.stringify(dir)}, pattern: "second line", glob: "*.ts"});
    const listing = await tools.list_directory({path: ${JSON.stringify(dir)}});
    return {matches, hasSubdirectory: listing.includes('sub/')};
  }` }));
  expect(result.result.matches).toContain("alpha.ts:2:second line");
  expect(result.result.hasSubdirectory).toBe(true);
  expect(r.approvals.size).toBe(0);
  expect(r.statuses).not.toContain("awaiting");
});

test("Full Access runs commands without asking", async () => {
  const r = runner(true);
  expect(await r.call("bash", { command: "printf full" })).toBe("exit 0\nfull");
  expect(r.statuses).not.toContain("awaiting");
  expect(r.statuses).not.toContain("judging");
});
