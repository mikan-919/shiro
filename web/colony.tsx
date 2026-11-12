import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Colony } from "../shared";
import { api } from "./sync";
import { Num } from "./ui";
import { useFlip } from "./motion";

const when = (at: number) => new Date(at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const SOURCE: Record<string, string> = { self: "自己申告", observer: "観察者" };

function Fields({ fields }: { fields: Record<string, string> }) {
  return <dl className="context-fields">{Object.entries(fields).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export type Job = "observe" | "stop" | "evolve";
export type ColonyProps = { data?: Colony; error?: string; decide: (action: "adopt" | "reject", target: number) => void; run: (job: Job) => void };

/** Loads the colony on mount, when a turn starts or ends, and whenever the server says it changed (`rev`): the observer and the evolver write after the turn. */
export function useColony(running: boolean, rev: number): ColonyProps {
  const [data, setData] = useState<Colony>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<Colony>("/api/colony").then((d) => live && setData(d), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [running, rev]);
  const call = (path: string, body: unknown = {}, method?: string) =>
    api<Colony>(path, body, method).then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message));
  return {
    data, error,
    decide: (action, target) => call("/api/colony/decide", { action, target }),
    run: (job) => (job === "stop" ? call("/api/colony/observe", undefined, "DELETE") : call(`/api/colony/${job}`)),
  };
}

/** A section that opens in place. Its heading and count are the whole closed state. */
function Fold({ title, count, children }: { title: string; count: ReactNode; children: ReactNode }) {
  return <details className="context-fold"><summary><span>{title}</span><small>{count}</small></summary>{children}</details>;
}

/** The schema's growth across every conversation: proposals waiting for the user, and the types adopted so far. */
export function SchemaView({ data, error, decide, run }: ColonyProps) {
  const [confirm, setConfirm] = useState<number>();
  // Deciding a proposal takes its card away; the rest close the gap.
  const flip = useFlip<HTMLDivElement>([data]);
  if (!data) return <p className="context-empty">{error || "読み込み中です。"}</p>;
  const reports = new Map(data.reports.map((r) => [r.seq, r]));
  const last = data.runs[0];
  return (
    <div className="context-stack" ref={flip}>
      <div className="context-bar">
        <p>未読の type-gap report <Num value={data.pending} /> / {data.threshold} 件{last && `・前回 ${when(last.at)}（report ${last.reports} 件から提案 ${last.proposals} 件）`}</p>
        <button type="button" disabled={data.busy.evolving || !data.pending} title="件数がたまるのを待たずに、未読の report でモデルを2回呼びます" onClick={() => run("evolve")}>{data.busy.evolving ? "提案と評価を実行中…" : "今すぐ提案と評価"}</button>
      </div>
      {error && <p className="context-alert" role="alert">{error}</p>}
      {last?.error && <p className="context-alert" role="alert">前回の提案と評価は失敗しました: {last.error}</p>}

      <section aria-labelledby="context-proposals">
        <div className="context-section-head"><h2 id="context-proposals">型の提案</h2><span><Num value={data.proposals.length} /> 件が未決</span></div>
        {data.proposals.length ? <ol className="context-notes">{data.proposals.map((p) => (
          <li className="context-card kind-proposal" key={p.seq} data-flip={`proposal:${p.seq}`}>
            <div className="context-card-head"><span className="context-tag">#{p.seq} {p.name}</span><span>{when(p.at)}</span></div>
            <p>{p.purpose}</p>
            <Fields fields={p.fields} />
            <p className="context-obligation">読み手の義務: {p.obligation}</p>
            <details className="context-covers"><summary>対応する report {p.covers.length} 件・欄 {p.cost.fields}・{p.cost.bytes} バイト</summary>
              <ul>{p.covers.map((n) => <li key={n}>#{n} {reports.get(n)?.wanted ?? "（見つかりません）"}</li>)}</ul>
            </details>
            <div className="context-decide">
              {confirm === p.seq ? <>
                <span>取り消せません。</span>
                <button type="button" className="primary" onClick={() => { setConfirm(undefined); decide("adopt", p.seq); }}>採用する</button>
                <button type="button" onClick={() => { setConfirm(undefined); decide("reject", p.seq); }}>却下する</button>
                <button type="button" onClick={() => setConfirm(undefined)}>やめる</button>
              </> : <button type="button" onClick={() => setConfirm(p.seq)}>採用か却下を決める</button>}
            </div>
          </li>
        ))}</ol> : <p className="context-empty">未決の提案はありません。report が {data.threshold} 件たまると、ターンの後に提案されます。</p>}
      </section>

      <section aria-labelledby="context-types">
        <div className="context-section-head" data-flip="head:types"><h2 id="context-types">採用済みの型</h2><span><Num value={data.types.length} /> 件</span></div>
        {data.types.length ? <ol className="context-notes">{data.types.map((t) => (
          <li className="context-card kind-gist" key={t.seq} data-flip={`type:${t.seq}`}>
            <div className="context-card-head"><span className="context-tag">{t.name}</span><span>#{t.seq}</span></div>
            <p>{t.purpose}</p>
            <Fields fields={t.fields} />
            <p className="context-obligation">読み手の義務: {t.obligation}</p>
          </li>
        ))}</ol> : <p className="context-empty">まだありません。ノート、タスク、type-gap report、定着事項は常に使えます。</p>}
      </section>
    </div>
  );
}

/** What the substrate log holds, for every conversation or (`conv`) only the open one. */
export function RecordsView({ data, error, run, conv }: ColonyProps & { conv?: string }) {
  const [only, setOnly] = useState(false);
  if (!data) return <p className="context-empty">{error || "読み込み中です。"}</p>;
  const mine = <T extends { conv: string }>(rows: T[]) => (only ? rows.filter((r) => r.conv === conv) : rows);
  const gaps = mine(data.reports);
  const settled = mine(data.settled);
  const turns = mine(data.turns);
  const labelled = mine(data.labelled);
  const { observing } = data.busy;
  const sum = (f: (t: Colony["turns"][number]) => number) => turns.reduce((n, t) => n + f(t), 0);
  return (
    <>
      <div className="context-bar">
        {conv ? <div className="segmented seg context-seg" role="radiogroup" aria-label="記録の範囲" style={{ "--n": 2, "--i": only ? 1 : 0 } as CSSProperties}>
          <span className="seg-thumb" aria-hidden="true" />
          <button type="button" role="radio" aria-checked={!only} className={only ? "" : "on"} onClick={() => setOnly(false)}>全会話</button>
          <button type="button" role="radio" aria-checked={only} className={only ? "on" : ""} onClick={() => setOnly(true)}>この会話</button>
        </div> : <span />}
        {observing ? <div className="context-bar-action">
          <span role="status">観察中 <Num value={observing.done} /> / {observing.total}</span>
          <button type="button" onClick={() => run("stop")}>中止する</button>
        </div> : <div className="context-bar-action">
          <span>未観察 <Num value={data.unobserved} /> ターン</span>
          <button type="button" disabled={!data.unobserved} title="観察者が1ターンにつきモデルを1回呼び、type-gap を探します。失敗した時点で止まります" onClick={() => run("observe")}>観察する</button>
        </div>}
      </div>
      {error && <p className="context-alert" role="alert">{error}</p>}
      {data.observeError && <p className="context-alert" role="alert">直近の観察は失敗しました: {data.observeError}</p>}

      <dl className="context-stats">
        <div><dt>ターン</dt><dd><Num value={turns.length} from={0} /></dd></div>
        <div><dt>参加者の起動</dt><dd><Num value={sum((t) => t.peers)} from={0} /></dd></div>
        <div><dt>複数参加のターン</dt><dd><Num value={turns.filter((t) => t.peers > 1).length} from={0} /></dd></div>
        <div><dt>failure</dt><dd><Num value={sum((t) => t.failure)} from={0} /></dd></div>
        <div><dt>観察</dt><dd><Num value={sum((t) => t.observed + t.observeFailed)} from={0} /><small>失敗 <Num value={sum((t) => t.observeFailed)} from={0} /></small></dd></div>
      </dl>

      <div className="context-folds">
        <Fold title="type-gap report" count={<><Num value={gaps.length} /> 件</>}>
          {gaps.length ? <ol className="context-notes">{gaps.map((r) => (
            <li className="context-card kind-type-gap" key={r.seq}>
              <div className="context-card-head"><span className="context-tag">#{r.seq} {SOURCE[r.source] ?? r.source}</span><span>{when(r.at)}・{r.conv.slice(0, 8)}</span></div>
              <dl className="context-fields">
                <div><dt>書きたかった状態</dt><dd>{r.wanted}</dd></div>
                <div><dt>歪め方</dt><dd>{r.distortion}</dd></div>
                <div><dt>調整コスト</dt><dd>{r.cost === "unmeasured" ? "未計測" : r.cost}</dd></div>
                <div><dt>根拠</dt><dd>{r.evidence.join(" ")}</dd></div>
              </dl>
            </li>
          ))}</ol> : <p className="context-empty">まだありません。</p>}
        </Fold>
        <Fold title="長期共有文脈" count={<>有効 <Num value={settled.filter((s) => !s.retracted).length} /> 件</>}>
          {settled.length ? <ol className="context-notes">{settled.map((s) => (
            <li className={`context-card ${s.retracted ? "retracted" : ""}`} key={s.seq}>
              <div className="context-card-head"><span className="context-tag">#{s.seq} {s.kind === "policy" ? "方針" : "環境"}{s.retracted ? "・打ち消し済み" : ""}</span><span>{s.cwd ?? "全ディレクトリ"}</span></div>
              <p>{s.text}</p>
            </li>
          ))}</ol> : <p className="context-empty">まだ定着事項はありません。</p>}
        </Fold>
        <Fold title="ターンの記録" count={<><Num value={turns.length} /> ターン</>}>
          {turns.length ? <div className="context-table"><table>
            <thead><tr><th>時刻</th><th>会話</th><th>参加者</th><th>タスク追加</th><th>ツール</th><th>type-gap</th><th>failure</th><th>観察</th></tr></thead>
            <tbody>{turns.map((t) => <tr key={t.turn}><td>{when(t.at)}</td><td>{t.conv.slice(0, 8)}</td><td>{t.peers}</td><td>{t.add}</td><td>{t.tool}</td><td>{t.gap}</td><td>{t.failure}</td><td>{t.observed ? "済" : t.observeFailed ? "失敗" : "—"}</td></tr>)}</tbody>
          </table></div> : <p className="context-empty">まだありません。</p>}
        </Fold>
        <Fold title="ラベル付きノート" count={<><Num value={labelled.length} /> 件</>}>
          {labelled.length ? <ol className="context-notes">{labelled.map((n) => (
            <li className="context-card" key={n.seq}>
              <div className="context-card-head"><span className="context-tag">#{n.seq} {n.agent}</span><span>{when(n.at)}・{n.conv.slice(0, 8)}</span></div>
              <p>{n.text}</p>
            </li>
          ))}</ol> : <p className="context-empty">[failure] か [type-gap] で始まるノートはありません。</p>}
        </Fold>
      </div>
    </>
  );
}
