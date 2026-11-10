import { test, expect } from "bun:test";
import { createBoard } from "./team";
import { apply, type Message } from "./shared";

test("task claims are atomic, owner-checked and releasable", () => {
  let saves = 0;
  const board = createBoard(undefined, () => saves++);
  const a = board.forAgent("a"), b = board.forAgent("b");
  a.act("add", "", "implement");
  a.act("add", "", "verify");
  const first = JSON.parse(a.act("claim", "", ""));
  expect(() => b.act("claim", first.id, "")).toThrow("unavailable");
  expect(() => b.act("complete", first.id, "fake")).toThrow("own");
  const second = JSON.parse(b.act("claim", "", ""));
  expect(first.id).not.toBe(second.id);
  a.act("release", first.id, "");
  b.act("claim", first.id, "");
  b.act("complete", first.id, "verified");
  expect(board.state.tasks[0]?.result).toBe("verified");
  expect(() => a.act("claim", first.id, "")).toThrow();
  a.act("publish", "", "evidence");
  expect(JSON.parse(b.act("read", "", "")).notes[0].text).toBe("evidence");
  expect(saves).toBeGreaterThan(0);
});

test("interleaved events update their own participant, preserving legacy events", () => {
  let m: Message[] = [];
  m = apply(m, { t: "assistant", id: "a", model: "x", agent: "shiro-1" });
  m = apply(m, { t: "assistant", id: "b", model: "x", agent: "shiro-2" });
  m = apply(m, { t: "say", message: "a", id: "say-a", text: "first" });
  m = apply(m, { t: "say", message: "b", id: "say-b", text: "second" });
  const before = m;
  m = apply(m, { t: "end", message: "a", status: "error", error: "test" });
  expect(m[0]?.role === "assistant" && m[0].status).toBe("error");
  expect(m[1]?.role === "assistant" && m[1].status).toBe("streaming");
  expect(m[1]).toBe(before[1]);
  expect(m[0]?.role === "assistant" && m[0].parts).toEqual([{ type: "say", id: "say-a", text: "first" }]);
  m = apply(m, { t: "end", status: "done" });
  expect(m[1]?.role === "assistant" && m[1].status).toBe("done");
  expect(apply(m, { t: "text_delta", message: "missing", text: "lost" })).toBe(m);
});
