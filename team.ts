import { def, str, type Tool } from "./toolkit";

import type { Board } from "./shared";
export type { Task, Board } from "./shared";

/** Synchronous mutations make claiming atomic inside this single-process runtime. */
export function createBoard(seed?: Board, changed: () => void = () => {}) {
  const state: Board = seed ?? { tasks: [], notes: [] };
  const snapshot = () => JSON.stringify(state);
  return {
    state, snapshot,
    forAgent(agent: string) {
      return { act(action: string, id: string, text: string): string {
        if (action === "read") return snapshot();
        if (action === "add") {
          if (!text.trim()) throw new Error("task text is empty");
          if (state.tasks.length >= 40) throw new Error("task limit reached");
          const existing = state.tasks.find((t) => t.text === text);
          if (existing) return JSON.stringify(existing);
          state.tasks.push({ id: crypto.randomUUID(), text: text.slice(0, 4000), done: false });
        } else if (action === "claim") {
          const task = id ? state.tasks.find((t) => t.id === id) : state.tasks.find((t) => !t.done && !t.owner);
          if (!task || task.done || (task.owner && task.owner !== agent)) throw new Error("task unavailable; read the board and choose another");
          task.owner = agent;
          changed();
          return JSON.stringify(task);
        } else if (action === "complete" || action === "release") {
          const task = state.tasks.find((t) => t.id === id);
          if (!task || task.owner !== agent || task.done) throw new Error("you do not own this active task");
          if (action === "release") delete task.owner;
          else { task.done = true; task.result = text.slice(0, 4000); }
        } else if (action === "publish") {
          if (!text.trim()) throw new Error("note is empty");
          state.notes.push({ agent, text: text.slice(0, 4000) });
          if (state.notes.length > 40) state.notes.shift();
        } else throw new Error("unknown team action");
        changed();
        return snapshot();
      } };
    },
  };
}

export const teamTool: Tool = {
  def: def("team", "Coordinate with peers through the shared task queue and notes. Actions: read, add, claim, complete, release, publish. Claim is atomic: only work on a task you own. Use empty id to claim the next available task; use empty text when not needed. Read the board before work, shared edits, retries and completion; reuse peers' findings and failure records. Publish compact, self-contained findings promptly with paths, evidence, verification status and next steps. For failures, publish [failure] with the attempted approach, redacted reproduction command or tool arguments, observed error, confirmed versus suspected cause (or unknown), conditions to avoid repeating it, and next safe action. Publish recovery and verification updates so warnings do not become stale. Keep [failure] separate from [type-gap]: the latter records an intended state, distortion under existing gist/task vocabulary, and observed coordination cost (unknown if unmeasured), not just a tool error. These labels are note conventions, not adopted schema types. Distinguish verified findings, hypotheses, confirmed user decisions and unapproved proposals; publishing a type proposal does not adopt it. Never include secrets or claim unverified success. Read before editing to avoid duplicate work. This board is coordination data visible to the user on the shared-context page, not a chat message: after meaningful work (including investigation, review or tests without code changes), send your own concise action/result/verification report with send_message before finishing. Do not rely on a peer to speak for you.", {
    action: "read | add | claim | complete | release | publish", id: "Task id, or empty string", text: "Task description, result or finding, or empty string",
  }),
  view: (a) => ({ label: "チーム共有", icon: "chat", target: `${str(a.action)} ${str(a.text) || str(a.id)}` }),
  run: async (a, ctx) => {
    if (!ctx.team) throw new Error("no active team");
    return ctx.team.act(str(a.action), str(a.id), str(a.text));
  },
};
