// Reads the substrate log: per turn, how many peers started and what they recorded. Run: bun report.ts [conversation id]
import { substrate, type SubstrateRow } from "./store";

const label = (r: SubstrateRow) => r.kind === "publish" ? /^\[(type-gap|failure)\]/i.exec(String((r.body as { text?: string }).text).trimStart())?.[1]?.toLowerCase() : undefined;
type Gap = { wanted: string; distortion: string; cost: string; evidence: string[]; source: string };

/** One row per turn, in log order. `gap` counts typed type-gap reports and v0 notes labelled [type-gap]. */
export function summarize(log: SubstrateRow[]) {
  const turns = new Map<string, { turn: string; conv: string; at: number; peers: Set<string>; add: number; tool: number; gap: number; failure: number }>();
  for (const r of log) {
    let t = turns.get(r.turn);
    if (!t) turns.set(r.turn, t = { turn: r.turn, conv: r.conv, at: r.at, peers: new Set(), add: 0, tool: 0, gap: 0, failure: 0 });
    if (r.agent !== "user" && r.agent !== "observer") t.peers.add(r.agent);
    if (r.kind === "add") t.add++;
    if (r.kind === "tool") t.tool++;
    if (r.kind === "type-gap" || label(r) === "type-gap") t.gap++;
    if (label(r) === "failure") t.failure++;
  }
  return [...turns.values()];
}

if (import.meta.main) {
  const log = substrate(process.argv[2]);
  const rows = summarize(log);
  console.table(rows.map((t) => ({
    time: new Date(t.at).toISOString().slice(0, 16), conv: t.conv.slice(0, 8), peers: t.peers.size, add: t.add, tool: t.tool, "type-gap": t.gap, failure: t.failure,
  })));
  const sum = (f: (t: (typeof rows)[number]) => number) => rows.reduce((n, t) => n + f(t), 0);
  const gaps = log.filter((r) => r.kind === "type-gap");
  const bySource = (s: string) => gaps.filter((r) => (r.body as Gap).source === s).length;
  const observed = log.filter((r) => r.kind === "observe");
  console.log(`${rows.length} turns, ${sum((t) => t.peers.size)} peer starts, ${rows.filter((t) => t.peers.size > 1).length} turns with more than one peer, ${sum((t) => t.failure)} failure`);
  console.log(`type-gap: ${bySource("self")} self-reported, ${bySource("observer")} observed; observer ran on ${observed.length} turns, ${observed.filter((r) => (r.body as { error?: string }).error).length} failed`);
  const when = (r: SubstrateRow) => `#${r.seq} ${new Date(r.at).toISOString().slice(0, 16)} ${r.agent}`;
  for (const r of gaps) { const g = r.body as Gap; console.log(`\n${when(r)} type-gap\n  wanted: ${g.wanted}\n  distortion: ${g.distortion}\n  cost: ${g.cost}\n  evidence: ${g.evidence.join(" ")}`); }
  const retracted = new Set(log.filter((r) => r.kind === "retract").map((r) => (r.body as { target: number }).target));
  for (const r of log) if (r.kind === "settled") { const s = r.body as { text: string; kind: string; cwd: string | null }; console.log(`\n${when(r)} settled [${s.kind}] ${s.cwd ?? "anywhere"}${retracted.has(r.seq) ? " (retracted)" : ""}\n  ${s.text}`); }
  for (const r of log) if (label(r)) console.log(`\n${when(r)}\n${(r.body as { text: string }).text}`);
}
