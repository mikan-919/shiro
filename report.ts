// Reads the substrate log: per turn, how many peers started and what they recorded. Run: bun report.ts [conversation id]
import { substrate, type Gist } from "./store";

const tag = (g: Gist) => g.kind === "publish" ? /^\[(type-gap|failure)\]/i.exec(String((g.body as { text?: string }).text).trimStart())?.[1]?.toLowerCase() : undefined;

/** One row per turn, in log order. Turns logged before peers recorded "start" count the peers that left any row. */
export function summarize(log: Gist[]) {
  const turns = new Map<string, { turn: string; conv: string; at: number; peers: Set<string>; add: number; tool: number; "type-gap": number; failure: number }>();
  for (const g of log) {
    let t = turns.get(g.turn);
    if (!t) turns.set(g.turn, t = { turn: g.turn, conv: g.conv, at: g.at, peers: new Set(), add: 0, tool: 0, "type-gap": 0, failure: 0 });
    if (g.agent !== "user") t.peers.add(g.agent);
    if (g.kind === "add" || g.kind === "tool") t[g.kind]++;
    const k = tag(g);
    if (k === "type-gap" || k === "failure") t[k]++;
  }
  return [...turns.values()];
}

if (import.meta.main) {
  const log = substrate(process.argv[2]);
  const rows = summarize(log);
  console.table(rows.map((t) => ({
    time: new Date(t.at).toISOString().slice(0, 16), conv: t.conv.slice(0, 8), peers: t.peers.size, add: t.add, tool: t.tool, "type-gap": t["type-gap"], failure: t.failure,
  })));
  const sum = (f: (t: (typeof rows)[number]) => number) => rows.reduce((n, t) => n + f(t), 0);
  console.log(`${rows.length} turns, ${sum((t) => t.peers.size)} peer starts, ${rows.filter((t) => t.peers.size > 1).length} turns with more than one peer, ${sum((t) => t["type-gap"])} type-gap, ${sum((t) => t.failure)} failure`);
  for (const g of log) if (tag(g)) console.log(`\n#${g.seq} ${new Date(g.at).toISOString().slice(0, 16)} ${g.agent}\n${(g.body as { text: string }).text}`);
}
