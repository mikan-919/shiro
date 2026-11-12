import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CodexEvent, respond } from "./codex";
import type { Push } from "./shared";

// Never open the user's conversation DB or call external model / approval APIs.
const dir = mkdtempSync(`${tmpdir()}/shiro-team-`);
const oldDB = process.env.SHIRO_DB;
process.env.SHIRO_DB = `${dir}/test.db`;
const { createAgent } = await import("./agent");
const store = await import("./store");
if (oldDB === undefined) delete process.env.SHIRO_DB; else process.env.SHIRO_DB = oldDB;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const item = (name: string, args: object): CodexEvent => ({ type: "item", item: { type: "function_call", call_id: "same-id", name, arguments: JSON.stringify(name === "team" ? { files: "", ...args } : args) } });
/** The queue starts empty and peers join only for unclaimed tasks, so the first peer queues one task per peer. */
function* seed(o: { session: string }, n = 4) {
  if (o.session.endsWith("shiro-1")) for (let i = 0; i < n; i++) yield item("team", { action: "add", id: "", text: `part ${i}` });
}
async function until(f: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!f()) {
    if (Date.now() > deadline) throw new Error("runtime did not settle");
    await Bun.sleep(5);
  }
}
/** `observer` answers the post-turn observer; by default it says nothing, so peer mocks never see that session. */
const setup = (peers: typeof respond, observer: typeof respond = async function* () {}) => {
  const pushes: Push[] = [];
  const response: typeof respond = (o) => (o.session.endsWith(":observer") ? observer(o) : peers(o));
  const agent = createAgent({ publish: (p) => pushes.push(p), cwd: dir, defaultModel: "test", response });
  const conv = agent.create({ autoApprove: false });
  return { agent, id: conv.id, pushes };
};

test("four peers start after prior ownership announcement, then overlap and preserve isolated history", async () => {
  const started: string[] = [];
  const gate = Promise.withResolvers<void>();
  const tasks = new Map<string, string>();
  const calls = new Map<string, number>();
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    const peer = o.session.split(":").at(-1)!;
    if (n === 0) {
      started.push(peer);
      const previous = `shiro-${Number(peer.split("-")[1]) - 1}`;
      if (started.length > 1) {
        expect(o.instructions).toContain(`Chat: ${previous} assigned`);
        expect(o.instructions).toContain(`"owner":"${previous}"`);
      }
      yield* seed(o);
      yield item("team", { action: "claim", id: "", text: "" });
    } else if (n === 1) {
      const task = JSON.parse((o.input.at(-1) as { output: string }).output);
      expect(task.owner).toBe(peer);
      tasks.set(peer, task.id);
      // Hold every peer until all four own a task: a finished peer releases its task for the next claim.
      if (tasks.size === 4) gate.resolve();
      yield item("send_message", { text: `${peer} assigned` });
    } else if (n === 2) {
      await gate.promise;
    }
  };
  const { agent, id, pushes } = setup(response);
  expect(agent.send(id, "work", [])).toBe("ok");
  expect(agent.send(id, "duplicate", [], agent.open(id)!.messages[0]!.id)).toBe("busy");
  await until(() => !agent.open(id)!.meta.running);
  expect(started).toEqual(["shiro-1", "shiro-2", "shiro-3", "shiro-4"]);
  expect(new Set(tasks.values()).size).toBe(4);
  const c = store.get(id)!;
  const bubbles = c.messages.filter((m) => m.role === "assistant" && m.parts.some((p) => p.type === "say"));
  expect(bubbles.length).toBe(4);
  expect(new Set(bubbles.map((m) => m.role === "assistant" && m.agent)).size).toBe(4);
  expect(new Set(c.board?.notes.map((n) => n.text)).size).toBe(4);
  expect(c.board?.tasks.every((t) => !t.owner)).toBe(true);
  expect(c.items.every((i) => i.type !== "function_call" && i.type !== "function_call_output")).toBe(true);
  const events = pushes.filter((p) => p.type === "ev");
  expect(events.map((p) => p.type === "ev" && p.seq)).toEqual(events.map((_, i) => i + 1));
  const firstUser = c.messages[0]!;
  expect(agent.send(id, "edited", [], firstUser.id)).toBe("ok");
  await until(() => !agent.open(id)!.meta.running);
  expect(store.get(id)!.messages[0]?.role === "user" && (store.get(id)!.messages[0] as { text: string }).text).toBe("edited");
  expect(store.get(id)!.items.length).toBe(1);
  agent.remove(id);
});

test("approval IDs are isolated and stopping resolves all pending approvals", async () => {
  const calls = new Map<string, number>();
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (n === 0) { yield* seed(o); yield item("team", { action: "claim", id: "", text: "" }); }
    if (n === 1) yield item("team", { action: "publish", id: "", text: "assigned approval test" });
    if (n === 2) yield item("bash", { command: "printf should-not-run" });
  };
  const { agent, id, pushes } = setup(response);
  agent.send(id, "test approvals", []);
  const pending = () => pushes.filter((p) => p.type === "ev" && p.ev.t === "tool_status" && p.ev.status === "awaiting");
  await until(() => pending().length === 4);
  const ids = pending().map((p) => p.type === "ev" && p.ev.t === "tool_status" ? p.ev.id : "");
  expect(new Set(ids).size).toBe(4);
  expect(agent.approve(id, "same-id", true)).toBe(false);
  agent.stop(id);
  await until(() => !agent.open(id)!.meta.running);
  expect(store.get(id)!.messages.filter((m) => m.role === "assistant").every((m) => m.role === "assistant" && m.status === "stopped")).toBe(true);
  expect(agent.approve(id, ids[0]!, true)).toBe(false);
  agent.remove(id);
});

test("deletion during generation never resurrects the conversation", async () => {
  const started: string[] = [];
  const response: typeof respond = async function* (o) {
    started.push(o.session);
    await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "text", text: "late" };
  };
  const { agent, id, pushes } = setup(response);
  agent.send(id, "delete me", []);
  agent.remove(id);
  const deleted = pushes.length;
  await Bun.sleep(20);
  expect(store.get(id)).toBeUndefined();
  expect(pushes.length).toBe(deleted);
  expect(started).toHaveLength(1);
});

test("one peer failing does not cancel the other", async () => {
  const calls = new Map<string, number>();
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (o.session.endsWith("shiro-1")) {
      if (n) throw new Error("peer failure");
      yield* seed(o);
    } else if (!n) yield item("send_message", { text: "still working" });
  };
  const { agent, id } = setup(response);
  agent.send(id, "continue", []);
  await until(() => !agent.open(id)!.meta.running);
  const messages = store.get(id)!.messages;
  expect(messages.some((m) => m.role === "assistant" && m.error === "peer failure")).toBe(true);
  expect(messages.some((m) => m.role === "assistant" && m.agent === "shiro-2" && m.parts.some((p) => p.type === "say"))).toBe(true);
  agent.remove(id);
});

test("shared workspace side effects execute serially even when all four are approved", async () => {
  const calls = new Map<string, number>();
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (n === 0) { yield* seed(o); yield item("team", { action: "claim", id: "", text: "" }); }
    if (n === 1) yield item("team", { action: "publish", id: "", text: "assigned serial test" });
    if (n === 2) {
      const peer = o.session.split(":").at(-1)!;
      yield item("bash", { command: `printf '${peer}-start\n' >> '${dir}/effects.log'; sleep 0.02; printf '${peer}-end\n' >> '${dir}/effects.log'` });
    }
  };
  const { agent, id, pushes } = setup(response);
  agent.send(id, "test serialization", []);
  const pending = () => pushes.flatMap((p) => p.type === "ev" && p.ev.t === "tool_status" && p.ev.status === "awaiting" ? [p.ev.id] : []);
  await until(() => pending().length === 4);
  for (const call of pending()) expect(agent.approve(id, call, true)).toBe(true);
  await until(() => !agent.open(id)!.meta.running);
  const lines = (await Bun.file(`${dir}/effects.log`).text()).trim().split("\n");
  expect(lines).toEqual(["shiro-1-start", "shiro-1-end", "shiro-2-start", "shiro-2-end", "shiro-3-start", "shiro-3-end", "shiro-4-start", "shiro-4-end"]);
  agent.remove(id);
});

test("restart settles every participant; board and named bubbles persist", async () => {
  const { Database } = await import("bun:sqlite");
  const response: typeof respond = async function* () {};
  const { agent, id } = setup(response);
  const c = store.get(id)!;
  c.messages = [
    { id: "one", role: "assistant", agent: "shiro-1", model: "test", status: "streaming", parts: [] },
    { id: "two", role: "assistant", agent: "shiro-2", model: "test", status: "streaming", parts: [{ type: "say", id: "say", text: "saved" }] },
  ];
  c.board = { tasks: [], notes: [{ agent: "shiro-1", text: "evidence" }], statuses: { "shiro-1": "finished", "shiro-2": "running", "shiro-3": "waiting", "shiro-4": "waiting" } };
  store.save(c);
  const db = new Database(`${dir}/test.db`, { readonly: true });
  const row = db.query<{ messages: string; board: string }, [string]>("SELECT messages, board FROM conversations WHERE id = ?").get(id)!;
  expect(JSON.parse(row.messages)[1].agent).toBe("shiro-2");
  expect(JSON.parse(row.board).notes[0].text).toBe("evidence");
  db.close();
  expect(agent.open(id)!.messages.filter((m) => m.role === "assistant").every((m) => m.role === "assistant" && m.status === "stopped")).toBe(true);
  expect(agent.open(id)!.board.statuses).toEqual({ "shiro-1": "finished", "shiro-2": "stopped", "shiro-3": "stopped", "shiro-4": "stopped" });
  agent.remove(id);
});

test("tool loops can finish normally beyond 100 rounds without a round limit", async () => {
  let calls = 0;
  const response: typeof respond = async function* () {
    calls++;
    if (calls <= 120) yield item("team", { action: "read", id: "", text: "" });
  };
  const { agent, id } = setup(response);
  agent.send(id, "long task", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(calls).toBe(121); // No task was queued, so only the first peer ever runs.
  const messages = store.get(id)!.messages.filter((m) => m.role === "assistant");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ status: "done" });
  agent.remove(id);
});

test("tool loops beyond 100 rounds still stop on user cancellation", async () => {
  let calls = 0;
  const response: typeof respond = async function* (o) {
    calls++;
    if (calls === 121) {
      await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve(), { once: true }));
      o.signal.throwIfAborted();
    }
    yield item("team", { action: "read", id: "", text: "" });
  };
  const { agent, id } = setup(response);
  agent.send(id, "loop until stopped", []);
  await until(() => calls === 121);
  expect(agent.open(id)!.meta.running).toBe(true);
  agent.stop(id);
  await until(() => !agent.open(id)!.meta.running);
  expect(calls).toBe(121);
  const messages = store.get(id)!.messages.filter((m) => m.role === "assistant");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ status: "stopped" });
  agent.remove(id);
});

test("shared board snapshots stream task, note and status updates and remain immutable", async () => {
  const calls = new Map<string, number>();
  const tasks = new Map<string, string>();
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (n === 0) { yield* seed(o); yield item("team", { action: "claim", id: "", text: "" }); }
    if (n === 1) {
      tasks.set(o.session, JSON.parse((o.input.at(-1) as { output: string }).output).id);
      yield item("team", { action: "publish", id: "", text: "[failure] attempted check; observed error; cause unknown" });
    }
    if (n === 2) yield item("team", { action: "complete", id: tasks.get(o.session), text: "verification result" });
  };
  const { agent, id, pushes } = setup(response);
  agent.send(id, "publish context", []);
  await until(() => !agent.open(id)!.meta.running);
  const boards = pushes.flatMap((p) => p.type === "ev" && p.ev.t === "board" ? [p.ev.board] : []);
  expect(boards.length).toBeGreaterThan(4);
  expect(boards[0]?.notes).toEqual([]);
  expect(boards[0]?.statuses?.["shiro-1"]).toBe("waiting");
  expect(boards.at(-1)?.statuses).toEqual({ "shiro-1": "finished", "shiro-2": "finished", "shiro-3": "finished", "shiro-4": "finished" });
  expect(boards.at(-1)?.tasks.every((t) => t.done && t.result === "verification result")).toBe(true);
  expect(agent.open(id)!.board.notes.length).toBe(4);
  expect(store.get(id)!.items.at(-1)).toMatchObject({ role: "assistant" });
  const { apply } = await import("./shared");
  const msgs = agent.open(id)!.messages;
  expect(apply(msgs, { t: "board", board: boards[0]! })).toBe(msgs);
  agent.remove(id);
});

test("peer bubbles reach the next prompt via shared context without leaking private tool history", async () => {
  const said = Promise.withResolvers<void>();
  const calls = new Map<string, number>();
  let observed = false;
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (o.session.endsWith("shiro-1")) {
      if (n === 0) { yield* seed(o); yield item("send_message", { text: "peer evidence ready" }); }
      else said.resolve();
    } else if (n === 0) {
      // The first prompt was already taken; only the NEXT request can see this note.
      await said.promise;
      yield item("team", { action: "read", id: "", text: "" });
    } else {
      observed = true;
      expect(o.instructions).toContain("Chat: peer evidence ready");
      expect(o.instructions).toContain("shiro-1");
      const privateCalls = o.input.filter((i) => i.type === "function_call");
      expect(privateCalls).toHaveLength(1);
      expect(privateCalls[0]).toMatchObject({ name: "team" });
      expect(o.input.some((i) => "role" in i && i.role === "assistant")).toBe(false);
    }
  };
  const { agent, id } = setup(response);
  agent.send(id, "share findings", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(observed).toBe(true);
  expect(store.get(id)!.items).toContainEqual({ role: "assistant", content: "[shiro-1] peer evidence ready" });
  agent.remove(id);
});

test("malformed and unknown calls keep error results in their own worker history", async () => {
  const calls = new Map<string, number>();
  const results: string[] = [];
  const response: typeof respond = async function* (o) {
    if (!o.session.endsWith("shiro-1")) return;
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (n > 0) results.push((o.input.at(-1) as { output: string }).output);
    if (n === 0) {
      yield { type: "item", item: { type: "function_call", call_id: "bad-json", name: "read_file", arguments: "[]" } };
    } else if (n === 1) yield item("nonexistent_tool", {});
    else if (n === 2) yield item("send_message", { text: "" });
  };
  const { agent, id } = setup(response);
  agent.send(id, "validate calls", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(results).toEqual([
    "error: arguments are not a JSON object",
    "error: unknown tool nonexistent_tool",
    "error: text is empty",
  ]);
  const parts = store.get(id)!.messages.flatMap((m) => m.role === "assistant" ? m.parts : []);
  const tools = parts.filter((p) => p.type === "tool");
  expect(tools).toHaveLength(2); // Invalid send_message stays silent, just like a valid one.
  expect(tools.every((p) => p.status === "error" && p.output?.startsWith("error: "))).toBe(true);
  expect(parts.some((p) => p.type === "say")).toBe(false);
  agent.remove(id);
});

test("publish before claim, claim alone and publishing after release do not start the next peer", async () => {
  const started: string[] = [];
  const calls = new Map<string, number>();
  const nextStarted = Promise.withResolvers<void>();
  const response: typeof respond = async function* (o) {
    const peer = o.session.split(":").at(-1)!;
    const n = calls.get(peer) ?? 0;
    calls.set(peer, n + 1);
    if (!n) started.push(peer);
    if (peer !== "shiro-1") { nextStarted.resolve(); return; }
    if (n <= 5) expect(started).toEqual(["shiro-1"]);
    if (n === 0) { yield* seed(o, 2); yield item("team", { action: "publish", id: "", text: "before claim" }); }
    else if (n === 1) yield item("team", { action: "claim", id: "", text: "" });
    else if (n === 2) yield item("team", { action: "release", id: JSON.parse((o.input.at(-1) as { output: string }).output).id, text: "" });
    else if (n === 3) yield item("team", { action: "publish", id: "", text: "no longer owned" });
    else if (n === 4) yield item("team", { action: "claim", id: "", text: "" });
    else if (n === 5) yield item("team", { action: "publish", id: "", text: "assignment ready" });
    else await nextStarted.promise;
  };
  const { agent, id } = setup(response);
  agent.send(id, "startup conditions", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(started).toEqual(["shiro-1", "shiro-2", "shiro-3", "shiro-4"]);
  expect(calls.get("shiro-1")).toBe(7);
  agent.remove(id);
});

test("stopping before assignment sharing never starts the three waiting peers", async () => {
  const started: string[] = [];
  let firstClaimed = false;
  const response: typeof respond = async function* (o) {
    const peer = o.session.split(":").at(-1)!;
    if (!firstClaimed) {
      started.push(peer);
      yield* seed(o);
      yield item("team", { action: "claim", id: "", text: "" });
    } else throw new Error("waiting peer unexpectedly started");
    // This generator's next invocation occurs after the claim was executed.
  };
  const calls = new Map<string, number>();
  const blocked: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (!n) yield* response(o);
    else {
      firstClaimed = true;
      await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve(), { once: true }));
      o.signal.throwIfAborted();
    }
  };
  const { agent, id, pushes } = setup(blocked);
  agent.send(id, "hold assignment", []);
  await until(() => firstClaimed);
  expect(started).toEqual(["shiro-1"]);
  expect(agent.open(id)!.board.statuses).toEqual({ "shiro-1": "running", "shiro-2": "waiting", "shiro-3": "waiting", "shiro-4": "waiting" });
  agent.stop(id);
  await until(() => !agent.open(id)!.meta.running);
  expect(started).toEqual(["shiro-1"]);
  expect(agent.open(id)!.board.statuses).toEqual({ "shiro-1": "stopped", "shiro-2": "stopped", "shiro-3": "stopped", "shiro-4": "stopped" });
  expect(agent.open(id)!.board.tasks.every((t) => !t.owner)).toBe(true);
  const assistants = pushes.flatMap((p) => p.type === "ev" && p.ev.t === "assistant" ? [p.ev.agent] : []);
  expect(assistants).toEqual(["shiro-1"]);
  agent.remove(id);
});

test("the substrate log keeps every coordination event after the board resets and the conversation is deleted", async () => {
  const calls = new Map<string, number>();
  const response: typeof respond = async function* (o) {
    if (!o.session.endsWith("shiro-1")) return;
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (n % 3 === 0) yield item("team", { action: "publish", id: "", text: "[type-gap] wanted: promise" });
    else if (n % 3 === 1) yield item("send_message", { text: "done" });
  };
  const { agent, id } = setup(response);
  for (const text of ["first", "second"]) {
    agent.send(id, text, []);
    await until(() => !agent.open(id)!.meta.running);
  }
  agent.remove(id);
  const log = store.substrate(id).filter((g) => g.agent !== "observer");
  expect(log.map((g) => `${g.agent}:${g.kind}`)).toEqual(Array(2).fill(["user:user", "shiro-1:start", "shiro-1:publish", "shiro-1:publish", "shiro-1:tool"]).flat());
  expect(log.filter((g) => (g.body as { text?: string }).text?.startsWith("[type-gap]"))).toHaveLength(2);
  expect(new Set(log.map((g) => g.turn)).size).toBe(2);
  expect(log.every((g) => g.v === store.SUBSTRATE_VERSION)).toBe(true);
  expect(log[4]!.body).toMatchObject({ name: "send_message", output: expect.any(String) });
});

test("peers start only for unclaimed tasks: chat runs one peer, and a task added later wakes one more", async () => {
  const started: string[] = [];
  const calls = new Map<string, number>();
  const second = Promise.withResolvers<void>();
  let chat = true;
  const response: typeof respond = async function* (o) {
    const peer = o.session.split(":").at(-1)!;
    const n = calls.get(peer) ?? 0;
    calls.set(peer, n + 1);
    if (!n) started.push(peer);
    if (peer !== "shiro-1") {
      if (!n) yield item("team", { action: "claim", id: "", text: "" });
      else second.resolve();
      return;
    }
    if (chat) { if (!n) yield item("send_message", { text: "hi" }); return; }
    if (n === 0) yield item("team", { action: "add", id: "", text: "mine" });
    else if (n === 1) yield item("team", { action: "claim", id: "", text: "" });
    else if (n === 2) yield item("team", { action: "publish", id: "", text: "assignment ready" });
    else if (n === 3) {
      // The gate is open, but nothing is unclaimed: no one else may be running yet.
      await Bun.sleep(20);
      expect(started).toEqual(["shiro-1"]);
      yield item("team", { action: "add", id: "", text: "extra" });
    } else await second.promise;
  };
  const { agent, id } = setup(response);
  agent.send(id, "chat", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(started).toEqual(["shiro-1"]);
  expect(agent.open(id)!.board.statuses).toEqual({ "shiro-1": "finished", "shiro-2": "idle", "shiro-3": "idle", "shiro-4": "idle" });
  started.length = 0;
  calls.clear();
  chat = false;
  agent.send(id, "work", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(started).toEqual(["shiro-1", "shiro-2"]);
  agent.remove(id);
});

test("the report counts started peers, queued tasks and labelled notes per turn", async () => {
  const { summarize } = await import("./report");
  const g = (turn: string, agent: string, kind: string, text = "") => ({ seq: 0, at: 0, v: 0, conv: "c", turn, agent, kind, body: { text } });
  const rows = summarize([
    g("t1", "user", "user"), g("t1", "shiro-1", "start"), g("t1", "shiro-1", "add"), g("t1", "shiro-1", "add"), g("t1", "shiro-2", "start"),
    g("t1", "shiro-2", "publish", " [Type-Gap] wanted a promise"), g("t1", "shiro-1", "publish", "[failure] exit 1"), g("t1", "shiro-1", "publish", "Chat: [type-gap] quoted"),
    g("t2", "user", "user"), g("t2", "shiro-1", "start"), g("t2", "shiro-1", "tool"),
  ]);
  expect(rows.map((t) => [t.peers.size, t.add, t.tool, t.gap, t.failure])).toEqual([[2, 2, 0, 1, 1], [1, 0, 1, 0, 0]]);
});

test("follow-ups during a final response persist immediately and trigger another request with text and images", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const inputs: unknown[] = [];
  const response: typeof respond = async function* (o) {
    calls++;
    inputs.push(structuredClone(o.input));
    if (calls === 1) await gate.promise;
  };
  const { agent, id, pushes } = setup(response);
  agent.send(id, "original", []);
  const original = agent.open(id)!.messages[0]!;
  expect(agent.send(id, "first follow-up", [])).toBe("ok");
  expect(agent.send(id, "image follow-up", ["data:image/png;base64,aGVsbG8="])).toBe("ok");
  expect(agent.send(id, "edit", [], original.id)).toBe("busy");
  expect(agent.open(id)!.messages.filter((m) => m.role === "user")).toHaveLength(3);
  expect(pushes.filter((p) => p.type === "ev" && p.ev.t === "user")).toHaveLength(3);
  expect(store.get(id)!.items).toHaveLength(3);
  gate.resolve();
  await until(() => !agent.open(id)!.meta.running);
  expect(calls).toBe(2);
  expect(inputs[0]).toHaveLength(1);
  expect(inputs[1]).toHaveLength(3);
  const users = agent.open(id)!.messages.filter((m) => m.role === "user");
  expect(inputs[1]).toMatchObject([
    { role: "user", content: expect.stringContaining("original") },
    { role: "user", content: `[#${users[1]!.id.replace(/-/g, "").slice(0, 8)}] first follow-up` },
    { role: "user", content: [
      { type: "input_text", text: expect.stringContaining("image follow-up") },
      { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
    ] },
  ]);
  expect(store.substrate(id).filter((g) => g.kind === "followup")).toHaveLength(2);
  // Editing a follow-up rewinds to its saved transcript boundary, not the start of the turn.
  expect(agent.send(id, "edited follow-up", [], users[1]!.id)).toBe("ok");
  await until(() => !agent.open(id)!.meta.running);
  expect(store.get(id)!.items).toHaveLength(2);
  expect(agent.open(id)!.messages.filter((m) => m.role === "user")).toHaveLength(2);
  agent.remove(id);
});

test("every active peer receives follow-ups once after pending tools, without sharing private histories", async () => {
  const calls = new Map<string, number>();
  const waiting = new Set<string>();
  const seen = new Set<string>();
  const gate = Promise.withResolvers<void>();
  const response: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (n === 0) { yield* seed(o); yield item("team", { action: "claim", id: "", text: "" }); }
    if (n === 1) yield item("team", { action: "publish", id: "", text: "assigned follow-up test" });
    if (n === 2) {
      waiting.add(o.session);
      await gate.promise;
      yield item("team", { action: "read", id: "", text: "" });
    }
    if (n === 3) {
      const followups = o.input.filter((i) => "role" in i && i.role === "user" && typeof i.content === "string" && i.content.includes("new instructions"));
      expect(followups).toHaveLength(1);
      expect(o.input.filter((i) => i.type === "function_call")).toHaveLength(o.session.endsWith("shiro-1") ? 7 : 3);
      seen.add(o.session);
      yield item("team", { action: "read", id: "", text: "" });
    }
    if (n === 4) expect(o.input.filter((i) => "role" in i && i.role === "user")).toHaveLength(2);
  };
  const { agent, id } = setup(response);
  agent.send(id, "start", []);
  await until(() => waiting.size === 4);
  expect(agent.send(id, "new instructions", [])).toBe("ok");
  gate.resolve();
  await until(() => !agent.open(id)!.meta.running);
  expect(seen.size).toBe(4);
  agent.remove(id);
});

test("follow-up while awaiting approval is accepted but a stopping turn stays busy", async () => {
  let calls = 0;
  const inputs: unknown[] = [];
  const response: typeof respond = async function* (o) {
    inputs.push(structuredClone(o.input));
    if (++calls === 1) yield item("bash", { command: "printf follow-up-test" });
  };
  const { agent, id, pushes } = setup(response);
  agent.send(id, "start", []);
  const pending = () => pushes.flatMap((p) => p.type === "ev" && p.ev.t === "tool_status" && p.ev.status === "awaiting" ? [p.ev.id] : []);
  await until(() => pending().length === 1);
  expect(agent.send(id, "while waiting", [])).toBe("ok");
  expect(agent.approve(id, pending()[0]!, false)).toBe(true);
  await until(() => !agent.open(id)!.meta.running);
  expect(JSON.stringify(inputs[1])).toContain("while waiting");
  agent.send(id, "start again", []);
  agent.stop(id);
  expect(agent.send(id, "too late", [])).toBe("busy");
  await until(() => !agent.open(id)!.meta.running);
  agent.remove(id);
});

test("a follow-up accepted while the scheduler settles still gets a responder", async () => {
  let delivered = false;
  let injected = false;
  let result = "";
  const response: typeof respond = async function* (o) {
    if (JSON.stringify(o.input).includes("last-moment follow-up")) delivered = true;
  };
  const agent = createAgent({
    cwd: dir, defaultModel: "test", response,
    publish: (p) => {
      if (!injected && p.type === "ev" && p.ev.t === "board" && p.ev.board.statuses?.["shiro-1"] === "finished") {
        injected = true;
        result = agent.send(p.conv, "last-moment follow-up", []);
      }
    },
  });
  const { id } = agent.create({});
  agent.send(id, "original", []);
  await until(() => !agent.open(id)!.meta.running);
  expect(injected).toBe(true);
  expect(result).toBe("ok");
  expect(delivered).toBe(true);
  expect(agent.open(id)!.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  expect(agent.open(id)!.board.statuses?.["shiro-1"]).toBe("finished");
  agent.remove(id);
});

test("the observer reads a finished turn once, appends cited type-gaps, and skips turns without gists", async () => {
  const { parseGaps } = await import("./observer");
  const seen: string[] = [];
  const calls = new Map<string, number>();
  let chat = false;
  const peers: typeof respond = async function* (o) {
    const n = calls.get(o.session) ?? 0;
    calls.set(o.session, n + 1);
    if (!o.session.endsWith("shiro-1")) return;
    if (chat) { if (!n) yield item("send_message", { text: "hi" }); return; }
    if (n === 0) yield item("team", { action: "add", id: "", text: "UI. owner files: web/app.tsx" });
    else if (n === 1) yield item("report_type_gap", { wanted: "file ownership", distortion: "wrote it in the task text", cost: "", evidence: "UI task" });
  };
  const observer: typeof respond = async function* (o) {
    const record = (o.input[0] as { content: string }).content;
    seen.push(record);
    expect(o.effort).toBe("low");
    const add = /gist #(\d+) shiro-1 task add/.exec(record)![1];
    const event = /event #(\d+) user user/.exec(record)![1];
    yield { type: "text", text: "```json\n" + JSON.stringify({ gaps: [
      { wanted: "who owns which files", distortion: "free text in the task", cost: "unmeasured", evidence: [Number(add), 999999] },
      { wanted: "cites no gist", distortion: "x", cost: "unmeasured", evidence: [Number(event)] },
    ] }) + "\n```" };
  };
  const { agent, id } = setup(peers, observer);
  agent.send(id, "work", []);
  await until(() => store.substrate(id).some((r) => r.kind === "observe"));
  const rows = store.substrate(id);
  const gaps = rows.filter((r) => r.kind === "type-gap").map((r) => r.body as { source: string; evidence: string[]; cost: string });
  expect(gaps.map((g) => g.source)).toEqual(["self", "observer"]);
  expect(gaps[0]).toMatchObject({ cost: "unmeasured", evidence: ["UI task"] });
  expect(gaps[1]!.evidence).toEqual([`#${rows.find((r) => r.kind === "add")!.seq}`]); // Unknown lines are dropped.
  expect(rows.find((r) => r.kind === "observe")!.body).toEqual({ gaps: 1 });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("shiro-1 type-gap: wanted file ownership"); // It sees the self-report, so it need not repeat it.
  expect(rows.every((r) => r.v === store.SUBSTRATE_VERSION)).toBe(true);
  chat = true;
  calls.clear();
  agent.send(id, "chat", []);
  await until(() => !agent.open(id)!.meta.running);
  await Bun.sleep(20);
  expect(seen).toHaveLength(1); // A bubble is not a gist: no model call for the chat turn.
  expect(() => parseGaps("not json", rows)).toThrow();
  agent.remove(id);
});

test("settled facts reach later conversations in the same directory until a peer retracts them", async () => {
  const prompts: string[] = [];
  const outputs: string[] = [];
  const script: [string, object][] = [];
  const peers: typeof respond = async function* (o) {
    prompts.push(o.instructions);
    const last = o.input.at(-1) as { output?: string };
    if (last.output) outputs.push(last.output);
    const next = script.shift();
    if (next) yield item(...next);
  };
  const run = async (...calls: [string, object][]) => {
    const { agent, id } = setup(peers);
    script.push(...calls);
    agent.send(id, "go", []);
    await until(() => !agent.open(id)!.meta.running);
    agent.remove(id);
  };
  await run(
    ["settle", { action: "add", kind: "environment", scope: "here", text: "python3 is not installed", target: "" }],
    ["settle", { action: "add", kind: "guess", scope: "here", text: "maybe", target: "" }],
    ["settle", { action: "add", kind: "policy", scope: "anywhere", text: "x".repeat(301), target: "" }],
    ["settle", { action: "retract", kind: "", scope: "", text: "typo", target: "999999" }],
  );
  const seq = /settled #(\d+)/.exec(outputs[0]!)![1]!;
  expect(outputs.slice(1).every((o) => o.startsWith("error: "))).toBe(true);
  expect(store.settled(dir).map((s) => s.body)).toEqual([{ text: "python3 is not installed", kind: "environment", cwd: dir }]);
  expect(store.settled("/elsewhere")).toEqual([]);
  prompts.length = 0;
  await run(["settle", { action: "retract", kind: "", scope: "", text: "installed python3 and ran it", target: seq }]);
  expect(prompts[0]).toContain(`#${seq} [environment] python3 is not installed`); // A new conversation starts with it.
  expect(prompts.at(-1)).not.toContain("python3 is not installed");
  expect(store.settled(dir)).toEqual([]);
  expect(store.substrate().filter((r) => r.kind === "settled" && r.seq === Number(seq))).toHaveLength(1); // Retracted, not deleted.
});

test("the evolver proposes types after enough reports, replays them, and only an adopted type can be written", async () => {
  const evolver = await import("./evolver");
  const { writeGistTool } = await import("./team");
  const { createBoard } = await import("./team");
  const gap = () => store.append({ conv: "c", turn: "t", agent: "observer", kind: "type-gap", body: { wanted: "handoff to a named peer", distortion: "note text", cost: "unmeasured", evidence: ["#1"], source: "observer" } });
  let calls = 0;
  const model: typeof respond = async function* (o) {
    calls++;
    const nums = [...(o.input[0] as { content: string }).content.matchAll(/report #(\d+)/g)].map((m) => Number(m[1]));
    yield { type: "text", text: o.instructions.startsWith("You design") ? JSON.stringify({ existing: [nums[0]], proposals: [
      { name: "handoff", purpose: "Remaining work offered to peers.", fields: { work: "what remains", why: "why it is handed off" }, obligation: "Claim it or leave it." },
      { name: "Bad Name", purpose: "x", fields: { a: "b" }, obligation: "x" },
    ] }) : JSON.stringify({ covers: [[...nums.slice(1), 999999]] }) };
  };
  while (evolver.pending().length < evolver.THRESHOLD - 1) gap();
  expect(await evolver.evolve("m", model)).toBe(0);
  expect(calls).toBe(0); // Below the threshold: no model call.
  gap();
  const reports = evolver.pending().map((r) => r.seq);
  expect(await evolver.evolve("m", model)).toBe(1);
  expect(calls).toBe(2);
  expect(evolver.pending()).toHaveLength(0);
  const [proposal] = evolver.open();
  expect(proposal!.body).toMatchObject({ name: "handoff", covers: reports.slice(1), cost: { fields: 2 } });
  expect(store.types()).toHaveLength(0);
  const team = createBoard().forAgent("shiro-1");
  const ctx = { team, substrate: { append: () => 0, settled: () => [], types: store.types, cwd: "/" } } as unknown as Parameters<typeof writeGistTool.run>[1];
  await expect(writeGistTool.run({ type: "handoff", fields: "{\"work\":\"tests\"}" }, ctx)).rejects.toThrow("no adopted");
  evolver.decide("adopt", proposal!.seq);
  expect(() => evolver.decide("reject", proposal!.seq)).toThrow("not an open proposal");
  expect(store.types().map((t) => t.body.name)).toEqual(["handoff"]);
  await expect(writeGistTool.run({ type: "handoff", fields: "{\"owner\":\"shiro-2\"}" }, ctx)).rejects.toThrow("no field owner");
  const board = JSON.parse(await writeGistTool.run({ type: "handoff", fields: "{\"work\":\"tests\"}" }, ctx) as string);
  expect(board.gists).toEqual([{ agent: "shiro-1", type: "handoff", fields: { work: "tests" } }]);
  const { teamInstructions } = await import("./instructions");
  expect(teamInstructions("shiro-1", "{}", {}, [], store.types())).toContain("- handoff {work: what remains; why: why it is handed off}");
});

test("past turns are observed on request: one call per unobserved turn, stopping at the first failure", async () => {
  const { unobserved, observing } = await import("./observer");
  const { colony } = await import("./evolver");
  for (const turn of ["past-1", "past-2"]) store.append({ conv: "past", turn, agent: "shiro-1", kind: "publish", body: { text: "a finding" } });
  let calls = 0;
  let fail = true;
  const observer: typeof respond = async function* () {
    calls++;
    if (fail) throw new Error("no auth");
    yield { type: "text", text: '{"gaps":[]}' };
  };
  const { agent, id, pushes } = setup(async function* () {}, observer);
  const todo = unobserved().length;
  expect(todo).toBeGreaterThanOrEqual(2);
  agent.observePast();
  expect(colony().busy.observing).toEqual({ done: 0, total: todo });
  await until(() => !observing());
  expect(calls).toBe(1); // The first failure stops the run.
  expect(colony().observeError).toBe("no auth");
  fail = false;
  agent.observePast();
  await until(() => !observing());
  expect(calls).toBe(1 + todo);
  expect(unobserved()).toEqual([]);
  expect(colony()).toMatchObject({ unobserved: 0, busy: { observing: null } });
  expect(colony().observeError).toBeUndefined();
  expect(colony().turns.find((t) => t.turn === "past-1")).toMatchObject({ conv: "past", observed: 1 });
  expect(pushes.some((p) => p.type === "colony")).toBe(true);
  agent.remove(id);
});
