import { useEffect, useState } from "react";
import type { Colony } from "../shared";
import { api } from "./sync";

const when = (at: number) => new Date(at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const SOURCE: Record<string, string> = { self: "自己申告", observer: "観察者" };

function Fields({ fields }: { fields: Record<string, string> }) {
  return <dl className="context-fields">{Object.entries(fields).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** Loads the colony on mount and again whenever a turn ends, since the observer and the evolver write after it. */
export function ColonySection({ running }: { running: boolean }) {
  const [data, setData] = useState<Colony>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (running) return;
    api<Colony>("/api/colony").then(setData, (e: Error) => setError(e.message));
    // The evolver runs after the observer, a few seconds after the turn: look once more.
    const t = setTimeout(() => api<Colony>("/api/colony").then(setData, () => {}), 15000);
    return () => clearTimeout(t);
  }, [running]);
  const decide = (action: "adopt" | "reject", target: number) =>
    api<Colony>("/api/colony/decide", { action, target }).then((d) => { setData(d); setError(""); }, (e: Error) => setError(e.message));
  return <ColonyView data={data} error={error} decide={decide} />;
}

export function ColonyView({ data, error, decide }: { data?: Colony; error?: string; decide: (action: "adopt" | "reject", target: number) => void }) {
  const [confirm, setConfirm] = useState<string>();
  if (!data) return <section aria-labelledby="context-colony"><h2 id="context-colony" className="context-colony-title">スキーマの進化</h2><p className="context-empty">{error || "読み込み中です。"}</p></section>;
  const reports = new Map(data.reports.map((r) => [r.seq, r]));
  const last = data.runs[0];
  const live = data.settled.filter((s) => !s.retracted);
  return (
    <section aria-labelledby="context-colony" className="context-colony">
      <div className="context-section-head"><h2 id="context-colony" className="context-colony-title">スキーマの進化</h2><span>基質スキーマ v{data.version}・全会話</span></div>
      <p className="context-description">ここから下は会話をまたぐ記録です。未読の type-gap report が {data.threshold} 件たまると、ターンの後に型の提案と評価が走ります。現在 {data.pending} / {data.threshold} 件です。{last && `前回の実行は ${when(last.at)} で、report ${last.reports} 件から提案 ${last.proposals} 件${last.error ? `（失敗: ${last.error}）` : ""}。`}</p>
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

      <h3 className="context-subhead">type-gap report <span>{data.reports.length} 件・新しい順・自己申告 {data.reports.filter((r) => r.source === "self").length}・観察者 {data.reports.filter((r) => r.source === "observer").length}</span></h3>
      {data.reports.length ? <details className="context-fold"><summary>一覧を開く</summary><ol className="context-notes">{data.reports.map((r) => (
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

      <h3 className="context-subhead">長期共有文脈 <span>有効 {live.length} 件・打ち消し済み {data.settled.length - live.length} 件</span></h3>
      {data.settled.length ? <ol className="context-notes">{data.settled.map((s) => (
        <li className={`context-card ${s.retracted ? "retracted" : ""}`} key={s.seq}>
          <div className="context-card-head"><span className="context-tag">#{s.seq} {s.kind === "policy" ? "方針" : "環境"}{s.retracted ? "・打ち消し済み" : ""}</span><span>{s.cwd ?? "全ディレクトリ"}</span></div>
          <p>{s.text}</p>
        </li>
      ))}</ol> : <p className="context-empty">まだ定着事項はありません。</p>}
    </section>
  );
}
