import type { Task } from "./shared";

const peers = ["shiro-1", "shiro-2", "shiro-3", "shiro-4"];

/** One turn's peer lifecycle. The caller owns the board, persistence and model/tool execution. */
export function createPeerScheduler({ signal, tasks, changed }: {
  signal: AbortSignal;
  tasks: () => Task[];
  changed: () => void;
}) {
  const statuses: Record<string, string> = Object.fromEntries(peers.map((agent) => [agent, "waiting"]));
  const ready = peers.map(() => Promise.withResolvers<void>());
  let wake = Promise.withResolvers<void>();
  const notify = () => { wake.resolve(); wake = Promise.withResolvers<void>(); };
  let active = 0;
  // Unfinished work stays claimable by running peers, but must not start a fresh peer.
  const abandoned = new Set<string>();
  const free = () => tasks().some((t) => !t.done && !t.owner && !abandoned.has(t.id));

  return {
    statuses,
    notify,
    /** Call once, and report successful team actions only (after the board mutation). */
    async run(worker: (agent: string, acted: (action: string) => void) => Promise<void>) {
      const unblock = () => { ready.forEach((gate) => gate.resolve()); notify(); };
      signal.addEventListener("abort", unblock, { once: true });
      try {
        await Promise.allSettled(peers.map(async (agent, index) => {
          // Only startup is ordered. Assignment sharing opens the next gate, but a peer
          // starts only while an unclaimed task exists: headcount follows the work.
          if (index > 0) {
            await ready[index - 1]!.promise;
            while (!signal.aborted && !free() && active > 0) await wake.promise;
          }
          if (signal.aborted || (index > 0 && !free())) {
            statuses[agent] = signal.aborted ? "stopped" : "idle";
            ready[index]!.resolve();
            changed();
            return;
          }
          statuses[agent] = "running";
          active++;
          changed();
          let claimed = false;
          const acted = (action: string) => {
            if (action === "claim") claimed = true;
            if (action === "publish" && claimed && tasks().some((t) => t.owner === agent && !t.done)) ready[index]!.resolve();
          };
          try {
            await worker(agent, acted);
          } finally {
            // A silent finish or failure must not strand peers behind an unopened gate.
            ready[index]!.resolve();
            if (statuses[agent] === "running") statuses[agent] = "finished";
            for (const task of tasks()) if (task.owner === agent && !task.done) { delete task.owner; abandoned.add(task.id); }
            changed();
            active--;
            notify();
          }
        }));
      } finally {
        signal.removeEventListener("abort", unblock);
      }
    },
  };
}
