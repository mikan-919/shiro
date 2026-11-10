// The observer: after a turn, reads its episode once and appends type-gap reports. It commands no one and claims no task.
// Run `bun observer.ts` to observe past turns that have not been observed yet (one model call per turn that holds a gist).
import * as store from "./store";
import type { respond } from "./codex";

const OBSERVER = "observer";
const cut = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n)}…` : t; };

const PROMPT = `You are the observer of a team of peer agents. You read the record of one finished turn and report type-gaps. You do not judge the work itself.
The peers coordinate only through gists. The schema has these gist types:
- note { agent, text }: free text published to peers.
- task { id, text, owner, done, result }: a unit of work that one peer claims and completes.
A distortion is a state a peer wanted to share that has no field in these types, so it was written into free text or bent into another shape. Examples of the pattern (do not copy them unless they occur): who owns which files, an obligation handed to a named peer, an interface two tasks agreed on, a condition under which a statement stops being true.
Report one type-gap per KIND of distortion in this turn, citing every gist line where it occurs. Ordinary findings, progress reports, tool errors and [failure] notes are not distortions. Reporting nothing is correct when the types were enough. A peer may already have reported a type-gap itself (a "type-gap" gist line); do not report the same kind again.
For cost, write "unmeasured" unless the record itself shows extra work caused by the distortion (duplicate work, a stale change, a clarification round); then describe it and cite those lines too.
Lines starting with "gist" are gists; lines starting with "event" are the surrounding episode, for judging cost only.
Answer with JSON only, in the language of the gists: {"gaps":[{"wanted":"the state the peer wanted to express","distortion":"how it was written instead","cost":"unmeasured | what it cost","evidence":[line numbers]}]}`;

type Gap = { wanted: string; distortion: string; cost: string; evidence: string[]; source: "self" | "observer" };

function render(rows: store.SubstrateRow[]) {
  return rows.map((r) => {
    const b = r.body as Record<string, unknown>;
    if (r.kind === "type-gap") return `gist #${r.seq} ${r.agent} type-gap: wanted ${cut(b.wanted, 300)}; written as ${cut(b.distortion, 300)}`;
    if (store.isGist(r)) return `gist #${r.seq} ${r.agent} ${r.kind === "publish" ? "note" : `task ${r.kind} ${cut(b.id, 40)}`}: ${cut(b.text, 1500)}`;
    if (r.kind === "tool") return `event #${r.seq} ${r.agent} ${b.name} ${cut(b.args, 200)} -> ${cut(b.output, 200)}`;
    return `event #${r.seq} ${r.agent} ${r.kind} ${cut(b.text, 300)}`;
  }).join("\n");
}

/** Keeps only reports that cite at least one gist of this turn: a report without evidence cannot be replayed. */
export function parseGaps(text: string, rows: store.SubstrateRow[]): Gap[] {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const gaps: unknown = (JSON.parse(json) as { gaps?: unknown }).gaps;
  if (!Array.isArray(gaps)) throw new Error("no gaps array");
  const known = new Map(rows.map((r) => [r.seq, r]));
  return gaps.flatMap((g): Gap[] => {
    const evidence = (Array.isArray(g?.evidence) ? g.evidence : []).map((e: unknown) => Number(String(e).replace("#", ""))).filter((n: number) => known.has(n));
    if (!g?.wanted || !g?.distortion || !evidence.some((n: number) => store.isGist(known.get(n)!))) return [];
    return [{ wanted: cut(g.wanted, 600), distortion: cut(g.distortion, 600), cost: cut(g.cost || "unmeasured", 600), evidence: evidence.map((n: number) => `#${n}`), source: "observer" }];
  });
}

/** At most one model call per turn, and none for a turn without gists or one already observed. Returns the number of reports, or -1 when the call or its answer failed. */
export async function observeTurn(conv: string, turn: string, model: string, response: typeof respond, signal = new AbortController().signal): Promise<number> {
  const rows = store.substrate(conv).filter((r) => r.turn === turn);
  if (!rows.some(store.isGist) || rows.some((r) => r.kind === "observe" && !(r.body as { error?: string }).error)) return 0;
  try {
    let text = "";
    const events = response({ model, effort: "low", instructions: PROMPT, input: [{ role: "user", content: render(rows) }], tools: [], session: `${conv}:${OBSERVER}`, signal });
    for await (const ev of events) if (ev.type === "text") text += ev.text;
    const gaps = parseGaps(text, rows);
    for (const gap of gaps) store.append({ conv, turn, agent: OBSERVER, kind: "type-gap", body: gap });
    store.append({ conv, turn, agent: OBSERVER, kind: "observe", body: { gaps: gaps.length } });
    return gaps.length;
  } catch (e) {
    // Recorded so failures can be counted; `bun observer.ts` retries a turn whose observation failed.
    store.append({ conv, turn, agent: OBSERVER, kind: "observe", body: { error: (e as Error).message } });
    return -1;
  }
}

if (import.meta.main) {
  const { respond } = await import("./codex");
  const { MODELS } = await import("./shared");
  const turns = new Map<string, string>();
  for (const r of store.substrate()) turns.set(r.turn, r.conv);
  for (const [turn, conv] of turns) {
    const n = await observeTurn(conv, turn, store.get(conv)?.meta.model ?? process.env.SHIRO_MODEL ?? MODELS[0].id, respond);
    console.log(`${conv.slice(0, 8)} ${turn.slice(0, 8)}: ${n < 0 ? "failed" : `${n} type-gap`}`);
    // One failure is likely to repeat (model, auth, answer format): stop instead of spending a call per turn.
    if (n < 0) { console.log(store.substrate(conv).findLast((r) => r.kind === "observe")?.body); break; }
  }
}
