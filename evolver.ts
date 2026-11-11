// The evolver: once enough type-gap reports have piled up, proposes gist types for them and replays the reports
// against each proposal. It adopts nothing: a proposal joins the schema only when the user adopts it (docs/adr/0003).
// Run `bun evolver.ts` to list open proposals, `bun evolver.ts adopt|reject <number>` to decide one,
// and `bun evolver.ts run` to evolve now regardless of the threshold.
import * as store from "./store";
import { schemaText } from "./observer";
import type { respond } from "./codex";
import type { Colony } from "./shared";

export const COLONY = "colony";
const EVOLVER = "evolver";
/** Reports no evolve run has read yet; a run starts once this many are pending. */
export const THRESHOLD = 10;

const PROPOSE = `You design the shared language of a team of peer agents. The peers coordinate only through gists, and the schema below lists the gist types they have.
You are given type-gap reports: each says a peer wanted to share a state that no field could hold, so it was bent into free text or another shape.
First, list the reports whose wanted state the current schema can already express (existing). Then, for the remaining reports, propose new gist types: as few as possible, each covering a kind of distortion that occurs in at least two reports. Do not propose a type for a single report, and do not propose a type that duplicates an existing one.
A type has a name (lowercase letters, digits and hyphens), a purpose, string fields (name -> what to write in it), and the obligation of a peer that reads such a gist.
The peers have no manager: a type must not let one peer command another.
Answer with JSON only, in the language of the reports: {"existing":[report numbers],"proposals":[{"name":"...","purpose":"...","fields":{"field":"description"},"obligation":"..."}]}`;

const REPLAY = `You check proposed gist types against type-gap reports. For each proposal and each report, decide whether the state the report wanted to share could have been written in that proposal's fields without free text. Be strict: a report is covered only when its wanted state fits the fields as described.
Answer with JSON only: {"covers":[[report numbers covered by proposal 0], [... by proposal 1], ...]}`;

export type Proposal = { name: string; purpose: string; fields: Record<string, string>; obligation: string; covers: number[]; cost: { fields: number; bytes: number } };

const json = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const BUILTIN = new Set(["note", "task", "type-gap", "settled", "retract"]);

/** A run reads every pending report, so a report counts once even when no proposal covers it.
 * ponytail: an uncovered report is not re-read later; replay over all reports if kinds that recur slowly go missing. */
export function pending(): store.SubstrateRow[] {
  const read = new Set(store.substrate(COLONY).flatMap((r) => r.kind === "evolve" && !(r.body as { error?: string }).error ? (r.body as { reports: number[] }).reports : []));
  return store.substrate().filter((r) => r.kind === "type-gap" && !read.has(r.seq));
}

const render = (reports: store.SubstrateRow[]) => reports.map((r) => {
  const g = r.body as { wanted: string; distortion: string; cost: string };
  return `report #${r.seq}: wanted ${g.wanted}; written as ${g.distortion}; cost ${g.cost}`;
}).join("\n");

async function ask(response: typeof respond, model: string, instructions: string, content: string, signal: AbortSignal) {
  let text = "";
  for await (const ev of response({ model, effort: "low", instructions, input: [{ role: "user", content }], tools: [], session: `${COLONY}:${EVOLVER}`, signal })) if (ev.type === "text") text += ev.text;
  return json(text);
}

let running = false;
/** Two model calls per run: one proposes, one replays. Returns the number of proposals recorded, or -1 when a call or its answer failed. */
export async function evolve(model: string, response: typeof respond, { force = false, signal = new AbortController().signal } = {}): Promise<number> {
  const reports = pending();
  if (running || !reports.length || (!force && reports.length < THRESHOLD)) return 0;
  // A failed run is retried only once a new report arrives, so one broken answer format does not cost a call per turn.
  const last = store.substrate(COLONY).findLast((r) => r.kind === "evolve");
  if (!force && last && (last.body as { error?: string }).error && last.seq > reports.at(-1)!.seq) return 0;
  running = true;
  const turn = crypto.randomUUID();
  const seqs = reports.map((r) => r.seq);
  try {
    const known = new Set(seqs);
    const nums = (v: unknown) => (Array.isArray(v) ? v : []).map((n) => Number(String(n).replace("#", ""))).filter((n) => known.has(n));
    const taken = new Set([...BUILTIN, ...store.types().map((t) => t.body.name)]);
    const proposed = await ask(response, model, PROPOSE, `${schemaText()}\n\n${render(reports)}`, signal);
    const drafts = (Array.isArray(proposed.proposals) ? proposed.proposals : []).filter((p: Proposal) =>
      NAME.test(String(p?.name)) && !taken.has(p.name) && p.fields && typeof p.fields === "object" && Object.keys(p.fields).length && p.purpose && p.obligation);
    const covers: unknown[] = drafts.length
      ? (await ask(response, model, REPLAY, `${drafts.map((p: Proposal, i: number) => `proposal ${i}: ${JSON.stringify({ ...p, covers: undefined })}`).join("\n")}\n\n${render(reports)}`, signal)).covers ?? []
      : [];
    const recorded = drafts.flatMap((p: Proposal, i: number) => {
      const covered = nums(covers[i]);
      if (!covered.length) return [];
      const fields = Object.fromEntries(Object.entries(p.fields).slice(0, 8).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 300)]));
      const body = { name: p.name, purpose: String(p.purpose).slice(0, 600), fields, obligation: String(p.obligation).slice(0, 600) };
      // Schema growth is what every later model call pays for: the fields to fill and the definition's prompt bytes.
      const proposal: Proposal = { ...body, covers: covered, cost: { fields: Object.keys(fields).length, bytes: new TextEncoder().encode(JSON.stringify(body)).length } };
      return [store.append({ conv: COLONY, turn, agent: EVOLVER, kind: "type-proposal", body: proposal })];
    });
    store.append({ conv: COLONY, turn, agent: EVOLVER, kind: "evolve", body: { reports: seqs, existing: nums(proposed.existing), proposals: recorded } });
    return recorded.length;
  } catch (e) {
    store.append({ conv: COLONY, turn, agent: EVOLVER, kind: "evolve", body: { reports: seqs, error: (e as Error).message } });
    return -1;
  } finally { running = false; }
}

/** Proposals the user has neither adopted nor rejected. */
export function open() {
  const decided = new Set(store.substrate(COLONY).filter((r) => r.kind === "adopt" || r.kind === "reject").map((r) => (r.body as { target: number }).target));
  return store.substrate(COLONY).filter((r) => r.kind === "type-proposal" && !decided.has(r.seq)) as (store.SubstrateRow & { body: Proposal })[];
}

/** The user's decision on one proposal. Adopting adds the type to the schema from the next model call on. */
export function decide(action: "adopt" | "reject", target: number) {
  if (!open().some((r) => r.seq === target)) throw new Error(`#${target} is not an open proposal`);
  return store.append({ conv: COLONY, turn: COLONY, agent: "user", kind: action, body: { target } });
}

/** Everything the shared-context page shows about the schema's evolution, newest first. */
export function colony(): Colony {
  const log = store.substrate();
  const retracted = new Set(log.filter((r) => r.kind === "retract").map((r) => (r.body as { target: number }).target));
  return {
    version: store.SUBSTRATE_VERSION, threshold: THRESHOLD, pending: pending().length,
    types: store.types().map((r) => ({ seq: r.seq, at: r.at, ...r.body })),
    proposals: open().map((r) => ({ seq: r.seq, at: r.at, ...r.body })).reverse(),
    reports: log.filter((r) => r.kind === "type-gap").map((r) => ({ seq: r.seq, at: r.at, conv: r.conv, ...(r.body as Omit<Colony["reports"][number], "seq" | "at" | "conv">) })).reverse(),
    settled: log.filter((r) => r.kind === "settled").map((r) => ({ seq: r.seq, at: r.at, ...(r.body as { kind: string; text: string; cwd: string | null }), retracted: retracted.has(r.seq) })).reverse(),
    runs: log.filter((r) => r.kind === "evolve").map((r) => {
      const b = r.body as { reports: number[]; proposals?: number[]; error?: string };
      return { seq: r.seq, at: r.at, reports: b.reports.length, proposals: b.proposals?.length ?? 0, ...(b.error && { error: b.error }) };
    }).reverse(),
  };
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "adopt" || cmd === "reject") console.log(`${cmd}ed #${arg} (row #${decide(cmd, Number(arg))})`);
  else if (cmd === "run") {
    const { respond } = await import("./codex");
    const { MODELS } = await import("./shared");
    const n = await evolve(process.env.SHIRO_MODEL ?? MODELS[0].id, respond, { force: true });
    console.log(n < 0 ? store.substrate(COLONY).findLast((r) => r.kind === "evolve")?.body : `${n} proposals`);
  }
  console.log(`${pending().length} pending type-gap reports (a run starts at ${THRESHOLD})`);
  for (const r of open()) {
    const p = r.body;
    console.log(`\n#${r.seq} ${p.name}: ${p.purpose}\n  fields: ${Object.entries(p.fields).map(([k, v]) => `${k} (${v})`).join(", ")}\n  reader: ${p.obligation}\n  covers ${p.covers.length} reports: ${p.covers.map((n) => `#${n}`).join(" ")}\n  cost: ${p.cost.fields} fields, ${p.cost.bytes} bytes`);
  }
}
