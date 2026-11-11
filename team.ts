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
      return { act(action: string, id: string, text: string, files = ""): string {
        const paths = files.split(/[,\n]/).map((f) => f.trim()).filter(Boolean).slice(0, 40);
        if (action === "read") return snapshot();
        if (action === "add") {
          if (!text.trim()) throw new Error("task text is empty");
          if (state.tasks.length >= 40) throw new Error("task limit reached");
          const existing = state.tasks.find((t) => t.text === text);
          if (existing) return JSON.stringify(existing);
          state.tasks.push({ id: crypto.randomUUID(), text: text.slice(0, 4000), done: false, ...(paths.length && { files: paths }) });
        } else if (action === "claim") {
          const task = id ? state.tasks.find((t) => t.id === id) : state.tasks.find((t) => !t.done && !t.owner);
          if (!task || task.done || (task.owner && task.owner !== agent)) throw new Error("task unavailable; read the board and choose another");
          task.owner = agent;
          if (paths.length) task.files = paths;
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
        } else if (action === "gist") {
          // write_gist validated the type and fields; id is the type name, text the fields as JSON.
          (state.gists ??= []).push({ agent, type: id, fields: JSON.parse(text) });
          if (state.gists.length > 40) state.gists.shift();
        } else throw new Error("unknown team action");
        changed();
        return snapshot();
      } };
    },
  };
}

export const teamTool: Tool = {
  def: def("team", "Coordinate with peers through the shared task queue and notes. Actions: read, add, claim, complete, release, publish. Claim is atomic: only work on a task you own. Use empty id to claim the next available task; use empty text when not needed. With add or claim, list in files the paths that task's owner will edit; before editing a file, read the board and do not edit a path listed on a peer's active task. Read the board before work, shared edits, retries and completion; reuse peers' findings and failure records. Publish compact, self-contained findings promptly with paths, evidence, verification status and next steps. For failures, publish [failure] with the attempted approach, redacted reproduction command or tool arguments, observed error, confirmed versus suspected cause (or unknown), conditions to avoid repeating it, and next safe action. Publish recovery and verification updates so warnings do not become stale. Distinguish verified findings from hypotheses. Never include secrets or claim unverified success. Read before editing to avoid duplicate work. This board is coordination data visible to the user on the shared-context page, not a chat message: after meaningful work (including investigation, review or tests without code changes), send your own concise action/result/verification report with send_message before finishing. Do not rely on a peer to speak for you.", {
    action: "read | add | claim | complete | release | publish", id: "Task id, or empty string", text: "Task description, result or finding, or empty string", files: "For add or claim: comma-separated paths the task's owner edits. Otherwise empty string",
  }),
  view: (a) => ({ label: "チーム共有", icon: "chat", target: `${str(a.action)} ${str(a.text) || str(a.id)}` }),
  run: async (a, ctx) => {
    if (!ctx.team) throw new Error("no active team");
    return ctx.team.act(str(a.action), str(a.id), str(a.text), str(a.files));
  },
};

const view = (label: string, field: string): Tool["view"] => (a) => ({ label, icon: "chat", target: str(a[field]) });

/** v1 gist type: a state the note and task types could not express. The observer writes the same type after the turn. */
export const gapTool: Tool = {
  def: def("report_type_gap", "Record that a state you needed peers to know has no field in a note or task, so you bent it into free text or another shape. Not for tool errors or failed attempts.", {
    wanted: "The state you wanted to express", distortion: "How you wrote it instead", cost: "Coordination cost actually observed (duplicate work, stale change, clarification round), or unmeasured",
    evidence: "Task id or a short quote of the note where the distortion is",
  }),
  view: view("type-gap", "wanted"),
  run: async (a, ctx) => {
    if (!ctx.substrate) throw new Error("no active team");
    if (!str(a.wanted).trim() || !str(a.distortion).trim()) throw new Error("wanted and distortion are required");
    const seq = ctx.substrate.append("type-gap", { wanted: str(a.wanted).slice(0, 600), distortion: str(a.distortion).slice(0, 600), cost: str(a.cost).slice(0, 600) || "unmeasured", evidence: [str(a.evidence).slice(0, 300)], source: "self" });
    return `recorded type-gap #${seq}`;
  },
};

/** v3: writes a gist of a type the user adopted from the evolver's proposals. Its fields are the type's own. */
export const writeGistTool: Tool = {
  def: def("write_gist", "Write a gist of one of the adopted gist types listed in your instructions, instead of bending that state into a note or task text. Peers see it on the board.", {
    type: "The adopted type's name", fields: "A JSON object whose keys are that type's fields and whose values are strings",
  }),
  view: view("gist", "type"),
  run: async (a, ctx) => {
    if (!ctx.team || !ctx.substrate) throw new Error("no active team");
    const type = ctx.substrate.types().find((t) => t.body.name === a.type);
    if (!type) throw new Error("no adopted gist type with this name");
    let fields: unknown;
    try { fields = JSON.parse(str(a.fields)); } catch { throw new Error("fields is not JSON"); }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields must be a JSON object");
    const entries = Object.entries(fields).filter(([, v]) => String(v ?? "").trim());
    const unknown = entries.filter(([k]) => !Object.hasOwn(type.body.fields, k)).map(([k]) => k);
    if (unknown.length) throw new Error(`${type.body.name} has no field ${unknown.join(", ")}; its fields are ${Object.keys(type.body.fields).join(", ")}`);
    if (!entries.length) throw new Error("no field is filled");
    return ctx.team.act("gist", type.body.name, JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, String(v).slice(0, 1000)]))));
  },
};

/** v1 gist types: a settled fact in the long-term shared context, and the retraction that takes one out of it. */
export const settleTool: Tool = {
  def: def("settle", "Long-term shared context, shared with peers in every later conversation. action add: record a fact whose cause you confirmed and that holds after this conversation ends. kind environment is a fact about this machine or repository (a missing command, a required flag); kind policy is a standing instruction the user gave. scope here applies to this working directory, anywhere to all. Never add hypotheses, progress, task findings or secrets. action retract: take fact number target out, with the evidence in text, once you confirm it no longer holds.", {
    action: "add | retract", kind: "environment | policy, or empty string for retract", scope: "here | anywhere, or empty string for retract",
    text: "The fact in one or two sentences (at most 300 characters), or the reason for retracting", target: "For retract: the fact's number without #. Otherwise empty string",
  }),
  view: view("長期共有文脈", "text"),
  run: async (a, ctx) => {
    if (!ctx.substrate) throw new Error("no active team");
    const text = str(a.text).trim();
    if (!text) throw new Error("text is empty");
    if (a.action === "retract") {
      const target = Number(a.target);
      if (!ctx.substrate.settled().some((s) => s.seq === target)) throw new Error("no such settled fact in the long-term shared context");
      ctx.substrate.append("retract", { target, reason: text.slice(0, 600) });
      return `retracted #${target}`;
    }
    if (a.action !== "add") throw new Error("unknown settle action");
    if (a.kind !== "environment" && a.kind !== "policy") throw new Error("kind must be environment or policy");
    if (a.scope !== "here" && a.scope !== "anywhere") throw new Error("scope must be here or anywhere");
    if (text.length > 300) throw new Error("text is longer than 300 characters; state only the fact");
    return `settled #${ctx.substrate.append("settled", { text, kind: a.kind, cwd: a.scope === "here" ? ctx.substrate.cwd : null })}`;
  },
};
