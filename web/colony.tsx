import { useEffect, useState } from "react";
import type { Colony } from "../shared";
import { api } from "./sync";

const when = (at: number) => new Date(at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const SOURCE: Record<string, string> = { self: "自己申告", observer: "観察者" };

function Fields({ fields }: { fields: Record<string, string> }) {
  return <dl className="context-fields">{Object.entries(fields).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export type Job = "observe" | "stop" | "evolve";

/** Loads the colony on mount, when a turn starts or ends, and whenever the server says it changed (`rev`): the observer and the evolver write after the turn. */
export function ColonySection({ running, rev, conv }: { running: boolean; rev: number; conv?: string }) {
  const [data, setData] = useState<Colony>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<Colony>("/api/colony").then((d) => live && setData(d), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [running, rev]);
  const call = (path: string, body: unknown = {}, method?: string) =>
    api<Colony>(path, body, method).then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message));
  const decide = (action: "adopt" | "reject", target: number) => call("/api/colony/decide", { action, target });
  const run = (job: Job) => (job === "stop" ? call("/api/colony/observe", undefined, "DELETE") : call(`/api/colony/${job}`));
  return <ColonyView data={data} error={error} decide={decide} run={run} conv={conv} />;
}

/** `conv` is the open conversation: the records below the types can be narrowed to it. */
export function ColonyView({ data, error, decide, run, conv }: { data?: Colony; error?: string; decide: (action: "adopt" | "reject", target: number) => void; run: (job: Job) => void; conv?: string }) {
  const [confirm, setConfirm] = useState<string>();
  const [only, setOnly] = useState(false);
  if (!data) return <section aria-labelledby="context-colony"><h2 id="context-colony" className="context-colony-title">スキーマの進化</h2><p className="context-empty">{error || "読み込み中です。"}</p></section>;
  const reports = new Map(data.reports.map((r) => [r.seq, r]));
  const last = data.runs[0];
  const mine = <T extends { conv: string }>(rows: T[]) => (only ? rows.filter((r) => r.conv === conv) : rows);
  const gaps = mine(data.reports);
  const settled = mine(data.settled);
  const turns = mine(data.turns);
  const labelled = mine(data.labelled);
  const live = settled.filter((s) => !s.retracted);
  const { observing, evolving } = data.busy;
  const sum = (f: (t: Colony["turns"][number]) => number) => turns.reduce((n, t) => n + f(t), 0);
  return (
    <section aria-labelledby="context-colony" className="context-colony">
      <div className="context-section-head"><h2 id="context-colony" className="context-colony-title">スキーマの進化</h2><span>基質スキーマ v{data.version}・全会話</span></div>
      <p className="context-description">ここから下は会話をまたぐ記録です。未読の type-gap report が {data.threshold} 件たまると、ターンの後に型の提案と評価が走ります。現在 {data.pending} / {data.threshold} 件です。{last && `前回の実行は ${when(last.at)} で、report ${last.reports} 件から提案 ${last.proposals} 件${last.error ? `（失敗: ${last.error}）` : ""}。`}</p>
      <div className="context-decide">
        <button type="button" disabled={evolving || !data.pending} onClick={() => run("evolve")}>{evolving ? "提案と評価を実行中…" : "今すぐ提案と評価を実行"}</button>
        <span>件数を待たずに、未読の report でモデルを2回呼びます。</span>
      </div>
      {error && <p className="context-empty" role="alert">{error}</p>}

      <h3 className="context-subhead">型の提案 <span>{data.proposals.length} 件が未決</span></h3>
      {data.proposals.length ? <ol className="context-notes">{data.proposals.map((p) => (
        <li className="context-card kind-proposal" key={p.seq}>
          <div className="context-card-head"><span className="context-tag">#{p.seq} {p.name}</span><span>{when(p.at)}</span></div>
          <p>{p.purpose}</p>
          <Fields fields={p.fields} />
          <p className="context-obligation">読み手の義務: {p.obligation}</p>
          <div className="context-metrics">
            <span>対応する report {p.covers.length} 件</span>
            <span>肥大コスト: 欄 {p.cost.fields}・{p.cost.bytes} バイト</span>
          </div>
          <details className="context-covers"><summary>対応する report を見る</summary>
            <ul>{p.covers.map((n) => <li key={n}>#{n} {reports.get(n)?.wanted ?? "（見つかりません）"}</li>)}</ul>
          </details>
          <div className="context-decide">
            {confirm === `${p.seq}` ? <>
              <span>取り消せません。</span>
              <button type="button" className="primary" onClick={() => { setConfirm(undefined); decide("adopt", p.seq); }}>採用する</button>
              <button type="button" onClick={() => { setConfirm(undefined); decide("reject", p.seq); }}>却下する</button>
              <button type="button" onClick={() => setConfirm(undefined)}>やめる</button>
            </> : <button type="button" onClick={() => setConfirm(`${p.seq}`)}>採用か却下を決める</button>}
          </div>
        </li>
      ))}</ol> : <p className="context-empty">未決の提案はありません。</p>}

      <h3 className="context-subhead">採用済みの型 <span>{data.types.length} 件</span></h3>
      {data.types.length ? <ol className="context-notes">{data.types.map((t) => (
        <li className="context-card kind-gist" key={t.seq}>
          <div className="context-card-head"><span className="context-tag">{t.name}</span><span>#{t.seq}</span></div>
          <p>{t.purpose}</p>
          <Fields fields={t.fields} />
          <p className="context-obligation">読み手の義務: {t.obligation}</p>
        </li>
      ))}</ol> : <p className="context-empty">v3 以降に採用された型はまだありません。v0〜v2 の型（ノート、タスク、type-gap report、定着事項）は常に使えます。</p>}

      {conv && <div className="context-filters context-scope" aria-label="記録の範囲">
        <button type="button" aria-pressed={!only} onClick={() => setOnly(false)}>全会話</button>
        <button type="button" aria-pressed={only} onClick={() => setOnly(true)}>この会話</button>
        <small>ここから下の report、定着事項、ターンの記録、ラベル付きノートを絞り込みます。</small>
      </div>}

      <h3 className="context-subhead">type-gap report <span>{gaps.length} 件・新しい順・自己申告 {gaps.filter((r) => r.source === "self").length}・観察者 {gaps.filter((r) => r.source === "observer").length}</span></h3>
      <div className="context-decide">
        {observing ? <>
          <span role="status">過去のターンを観察中です（{observing.done} / {observing.total}）。</span>
          <button type="button" onClick={() => run("stop")}>中止する</button>
        </> : <>
          <button type="button" disabled={!data.unobserved} onClick={() => run("observe")}>未観察のターンを観察する</button>
          <span>未観察 {data.unobserved} ターン。1ターンにつきモデルを1回呼び、失敗した時点で止まります。</span>
        </>}
      </div>
      {data.observeError && <p className="context-empty" role="alert">直近の観察は失敗しました: {data.observeError}</p>}
      {gaps.length ? <details className="context-fold"><summary>一覧を開く</summary><ol className="context-notes">{gaps.map((r) => (
        <li className="context-card kind-type-gap" key={r.seq}>
          <div className="context-card-head"><span className="context-tag">#{r.seq} {SOURCE[r.source] ?? r.source}</span><span>{when(r.at)}・{r.conv.slice(0, 8)}</span></div>
          <dl className="context-fields">
            <div><dt>書きたかった状態</dt><dd>{r.wanted}</dd></div>
            <div><dt>歪め方</dt><dd>{r.distortion}</dd></div>
            <div><dt>調整コスト</dt><dd>{r.cost === "unmeasured" ? "未計測" : r.cost}</dd></div>
            <div><dt>根拠</dt><dd>{r.evidence.join(" ")}</dd></div>
          </dl>
        </li>
      ))}</ol></details> : <p className="context-empty">まだ type-gap report はありません。</p>}

      <h3 className="context-subhead">長期共有文脈 <span>有効 {live.length} 件・打ち消し済み {settled.length - live.length} 件</span></h3>
      {settled.length ? <ol className="context-notes">{settled.map((s) => (
        <li className={`context-card ${s.retracted ? "retracted" : ""}`} key={s.seq}>
          <div className="context-card-head"><span className="context-tag">#{s.seq} {s.kind === "policy" ? "方針" : "環境"}{s.retracted ? "・打ち消し済み" : ""}</span><span>{s.cwd ?? "全ディレクトリ"}</span></div>
          <p>{s.text}</p>
        </li>
      ))}</ol> : <p className="context-empty">まだ定着事項はありません。</p>}

      <h3 className="context-subhead">ターンの記録 <span>{turns.length} ターン・参加者の起動 {sum((t) => t.peers)} 回・複数参加 {turns.filter((t) => t.peers > 1).length} ターン・failure {sum((t) => t.failure)} 件・観察 {sum((t) => t.observed + t.observeFailed)} 回（失敗 {sum((t) => t.observeFailed)}）</span></h3>
      {turns.length ? <details className="context-fold"><summary>一覧を開く</summary><div className="context-table"><table>
        <thead><tr><th>時刻</th><th>会話</th><th>参加者</th><th>タスク追加</th><th>ツール</th><th>type-gap</th><th>failure</th><th>観察</th></tr></thead>
        <tbody>{turns.map((t) => <tr key={t.turn}><td>{when(t.at)}</td><td>{t.conv.slice(0, 8)}</td><td>{t.peers}</td><td>{t.add}</td><td>{t.tool}</td><td>{t.gap}</td><td>{t.failure}</td><td>{t.observed ? "済" : t.observeFailed ? "失敗" : "—"}</td></tr>)}</tbody>
      </table></div></details> : <p className="context-empty">まだターンの記録はありません。</p>}

      <h3 className="context-subhead">ラベル付きノート <span>{labelled.length} 件・[failure] と v0 の [type-gap]</span></h3>
      {labelled.length ? <details className="context-fold"><summary>一覧を開く</summary><ol className="context-notes">{labelled.map((n) => (
        <li className="context-card" key={n.seq}>
          <div className="context-card-head"><span className="context-tag">#{n.seq} {n.agent}</span><span>{when(n.at)}・{n.conv.slice(0, 8)}</span></div>
          <p>{n.text}</p>
        </li>
      ))}</ol></details> : <p className="context-empty">ラベル付きのノートはありません。</p>}
    </section>
  );
}
