import { test, expect } from "bun:test";
import { usable } from "./tools";

test("edit_file replaces only a unique match", async () => {
  const p = `${import.meta.dir}/.tmp-edit.txt`;
  await Bun.write(p, "a $& b a");
  const edit = usable("edit_file")!;
  const ctx = { signal: new AbortController().signal, model: "", chat: { say() {}, react: () => false } };
  await expect(edit.run({ path: p, old_str: "a", new_str: "x" }, ctx)).rejects.toThrow("2 times");
  await edit.run({ path: p, old_str: " b", new_str: " $1" }, ctx);
  expect(await Bun.file(p).text()).toBe("a $& $1 a");
  await Bun.file(p).delete();
});

test("accountIdOf reads chatgpt_account_id from the JWT payload", async () => {
  const { accountIdOf } = await import("./auth");
  const p = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_1" } })).toString("base64url");
  expect(accountIdOf(`h.${p}.s`)).toBe("acc_1");
  expect(() => accountIdOf(`h.${Buffer.from("{}").toString("base64url")}.s`)).toThrow();
});

test("apply builds an assistant message from streamed events", async () => {
  const { apply } = await import("./shared");
  type M = import("./shared").Message[];
  let m: M = [];
  m = apply(m, { t: "user", msg: { id: "u", role: "user", text: "hi", images: [], itemIndex: 0 } });
  m = apply(m, { t: "assistant", id: "a", model: "x" });
  m = apply(m, { t: "reasoning_delta", text: "**Look**" });
  m = apply(m, { t: "reasoning_end" });
  m = apply(m, { t: "text_delta", text: "he" });
  m = apply(m, { t: "text_delta", text: "llo" });
  m = apply(m, { t: "tool", id: "c1", name: "bash", args: "{}", view: { label: "コマンド", icon: "terminal", target: "" } });
  m = apply(m, { t: "tool_status", id: "c1", status: "done", output: "ok" });
  m = apply(m, { t: "text_delta", text: "done" });
  const before = m;
  m = apply(m, { t: "end", status: "done" });
  const a = m[1]!;
  expect(a.role === "assistant" && a.status).toBe("done");
  expect(a.role === "assistant" && a.parts.map((p) => p.type)).toEqual(["reasoning", "text", "tool", "text"]);
  expect(a.role === "assistant" && a.parts[1]).toEqual({ type: "text", text: "hello" });
  expect(before[1]).not.toBe(m[1]); // immutable for React
  expect(apply(m, { t: "truncate", at: 0 })).toEqual([]);
});

test("neverAuto keeps risky commands for the user and lets plain ones through to Jev", async () => {
  const { neverAuto } = await import("./approve");
  for (const cmd of [
    "rm -rf build", "sudo apt install x", "git push origin main", "cd a && git reset --hard", "echo $(cat x)",
    "cat .env", "/usr/bin/git push", "env FOO=1 bash -c 'x'", "bun -e 'x'", "echo hi > out.txt", "curl -X POST https://x",
    "npx vercel deploy", "FOO=bar rm -fr .", "ls | xargs rm",
    "'rm' -rf x", "cat \".env\"", "grep 'a' x > out", "echo \"$HOME|x\"", "grep 'x' a | sh",
    "echo \"a'b\"; rm -rf x; echo 'c'", "echo \\' ; rm -rf x ; echo \\'",
  ]) expect([cmd, neverAuto(cmd)]).not.toEqual([cmd, null]);
  for (const cmd of ["ls -la", "git status", "bun test 2>&1", "cat src/a.ts | head -20", "git diff > /dev/null", "./node_modules/.bin/tsc --noEmit", "grep -rn TODO .",
    "rg -n 'theme|localStorage|text' web/a.tsx", "grep -E \"a|b>c\" x", "git log --format='%h %s' -3"])
    expect([cmd, neverAuto(cmd)]).toEqual([cmd, null]);
});

test("formatResults links titles and quotes excerpts", async () => {
  const { formatResults } = await import("./search");
  expect(formatResults([])).toBe("No results.");
  const md = formatResults([
    { url: "https://a.example/x", title: "A [draft]", publish_date: "2026-11-01", excerpts: ["one", "two\nlines"] },
    { url: "https://b.example", title: null, excerpts: [] },
  ]);
  expect(md).toBe(
    "1. [A draft](https://a.example/x) (2026-11-01)\n   > one\n   > …\n   > two\n   > lines\n\n2. [https://b.example](https://b.example)",
  );
});
