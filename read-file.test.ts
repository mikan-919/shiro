import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { available, usable } from "./tools";
import { toolDeclaration, validateArgs, type Args } from "./toolkit";

const root = await mkdtemp(join(tmpdir(), "shiro-read-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const tool = usable("read_file")!;
async function read(args: Args, signal = new AbortController().signal) {
  validateArgs(tool, args);
  return tool.run(args, { signal, model: "test", chat: { say() {}, react: () => true } });
}
const path = join(root, "text.txt");
await writeFile(path, "一行\r\n二行\n三行\n末尾");

test("read_file remains path-only compatible and preserves line endings", async () => {
  expect(await read({ path })).toBe("一行\r\n二行\n三行\n末尾");
  expect(await read({ path, start_line: 2, end_line: 3 })).toBe("二行\n三行\n");
  expect(await read({ path, end_line: 1 })).toBe("一行\r\n");
  expect(await read({ path, start_line: 4 })).toBe("末尾");
  expect(await read({ path, start_line: 5 })).toBe("");
  const empty = join(root, "empty");
  await writeFile(empty, "");
  expect(await read({ path: empty })).toBe("");
});

test("read_file validates line bounds and reports missing/non-file paths", async () => {
  for (const extra of [{ start_line: 0 }, { start_line: -1 }, { start_line: 1.5 }, { end_line: "2" }, { start_line: 3, end_line: 2 }, { end_line: null }, { start_line: Number.MAX_SAFE_INTEGER + 1 }]) {
    await expect(read({ path, ...extra })).rejects.toThrow();
  }
  await expect(read({ path: join(root, "missing") })).rejects.toThrow();
  await expect(read({ path: root })).rejects.toThrow("regular file");
  const ctl = new AbortController(); ctl.abort();
  await expect(read({ path }, ctl.signal)).rejects.toThrow();
});

test("read_file bounds output and scan while handling UTF-8/chunk boundaries", async () => {
  const large = join(root, "large");
  await writeFile(large, "x".repeat(65535) + "日\nsecond\n");
  expect(await read({ path: large, start_line: 2, end_line: 2 })).toBe("second\n");
  const out = await read({ path: large });
  expect(out.startsWith("x".repeat(50000))).toBe(true);
  expect(out).toContain("output truncated");
  expect(out.length).toBeLessThan(50100);
  await writeFile(large, "x".repeat(8 * 1024 * 1024 + 100) + "\nsecond");
  expect(await read({ path: large, start_line: 2 })).toContain("scan truncated at 8MiB");
});

test("read tools are registered and exposed to Code Mode without command approvals", () => {
  for (const name of ["read_file", "list_directory", "search_files", "search_text"]) {
    expect(available().some((t) => t.def.name === name)).toBe(true);
    expect(usable(name)?.command).toBeUndefined();
  }
  expect(toolDeclaration(tool)).toContain('"start_line"?: number');
  if (usable("execute_code")) expect(usable("execute_code")!.def.description).toContain('"search_text"');
});
