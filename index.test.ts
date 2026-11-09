import { test, expect } from "bun:test";
import { runTool } from "./index";

test("edit_file replaces only a unique match", async () => {
  const p = `${import.meta.dir}/.tmp-edit.txt`;
  await Bun.write(p, "a $& b a");
  const no = async () => false;
  expect(runTool("edit_file", { path: p, old_str: "a", new_str: "x" }, no)).rejects.toThrow("2 times");
  await runTool("edit_file", { path: p, old_str: " b", new_str: " $1" }, no);
  expect(await Bun.file(p).text()).toBe("a $& $1 a");
  expect(await runTool("bash", { command: "echo hi" }, no)).toBe("user denied this command");
  await Bun.file(p).delete();
});
