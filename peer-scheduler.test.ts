import { expect, test } from "bun:test";
import { createPeerScheduler } from "./peer-scheduler";
import type { Task } from "./shared";

function setup(tasks: Task[] = [], ctl = new AbortController()) {
  const snapshots: Record<string, string>[] = [];
  const scheduler = createPeerScheduler({
    signal: ctl.signal, tasks: () => tasks,
    changed: () => snapshots.push({ ...scheduler.statuses }),
  });
  return { scheduler, snapshots };
}

test("unfinished owned work is released but does not start a fresh peer", async () => {
  const tasks: Task[] = [{ id: "work", text: "unfinished", done: false }];
  const { scheduler, snapshots } = setup(tasks);
  const started: string[] = [];
  await scheduler.run(async (agent, acted) => {
    started.push(agent);
    tasks[0]!.owner = agent;
    acted("claim");
    // Finishing without sharing still opens the gate, but abandoned work cannot grow headcount.
  });
  expect(started).toEqual(["shiro-1"]);
  expect(tasks[0]!.owner).toBeUndefined();
  expect(scheduler.statuses).toEqual({ "shiro-1": "finished", "shiro-2": "idle", "shiro-3": "idle", "shiro-4": "idle" });
  expect(snapshots[0]?.["shiro-1"]).toBe("running");
});

test("an already aborted turn never starts a worker", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const { scheduler } = setup([{ id: "work", text: "queued", done: false }], ctl);
  const started: string[] = [];
  await scheduler.run(async (agent) => { started.push(agent); });
  expect(started).toEqual([]);
  expect(Object.values(scheduler.statuses)).toEqual(["stopped", "stopped", "stopped", "stopped"]);
});

test("a failed peer retains its error status and unblocks peers for other work", async () => {
  const tasks: Task[] = [
    { id: "unfinished", text: "mine", done: false },
    { id: "available", text: "other work", done: false },
  ];
  const { scheduler } = setup(tasks);
  const started: string[] = [];
  await scheduler.run(async (agent, acted) => {
    started.push(agent);
    const task = tasks.find((t) => !t.owner && !t.done)!;
    task.owner = agent;
    acted("claim");
    if (agent === "shiro-1") {
      scheduler.statuses[agent] = "error";
      return;
    }
    // The released task is still claimable by an already started peer.
    expect(task.id).toBe("unfinished");
    for (const t of tasks) { t.owner = agent; t.done = true; }
  });
  expect(started).toEqual(["shiro-1", "shiro-2"]);
  expect(scheduler.statuses["shiro-1"]).toBe("error");
  expect(scheduler.statuses["shiro-2"]).toBe("finished");
  expect(tasks.every((t) => t.done)).toBe(true);
});
