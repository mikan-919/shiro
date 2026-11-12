// Reads the substrate log: per turn, how many peers started and what they recorded. The shared-context page shows it.
import type { SubstrateRow } from "./store";

/** "type-gap" or "failure" for a note that starts with that label in brackets: the v0 way to report either. */
export const label = (r: SubstrateRow) => r.kind === "publish" ? /^\[(type-gap|failure)\]/i.exec(String((r.body as { text?: string }).text).trimStart())?.[1]?.toLowerCase() : undefined;

/** One row per turn, in log order. `gap` counts typed type-gap reports and v0 notes labelled [type-gap]. */
export function summarize(log: SubstrateRow[]) {
  const turns = new Map<string, { turn: string; conv: string; at: number; peers: Set<string>; add: number; tool: number; gap: number; failure: number; observed: number; observeFailed: number }>();
  for (const r of log) {
    let t = turns.get(r.turn);
    if (!t) turns.set(r.turn, t = { turn: r.turn, conv: r.conv, at: r.at, peers: new Set(), add: 0, tool: 0, gap: 0, failure: 0, observed: 0, observeFailed: 0 });
    if (r.agent !== "user" && r.agent !== "observer") t.peers.add(r.agent);
    if (r.kind === "add") t.add++;
    if (r.kind === "tool") t.tool++;
    if (r.kind === "type-gap" || label(r) === "type-gap") t.gap++;
    if (label(r) === "failure") t.failure++;
    if (r.kind === "observe") t[(r.body as { error?: string }).error ? "observeFailed" : "observed"]++;
  }
  return [...turns.values()];
}
