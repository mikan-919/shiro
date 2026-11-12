import { useState, type CSSProperties } from "react";
import type { Board } from "../shared";
import { CopyButton } from "./ui";
import { RecordsView, SchemaView, useColony } from "./colony";
import "./context.css";

const TABS = [
  { id: "board", label: "ボード" },
  { id: "schema", label: "スキーマ" },
  { id: "records", label: "記録" },
] as const;
const FILTERS = [
  { id: "all", label: "すべて" },
  { id: "finding", label: "共有ノート" },
  { id: "failure", label: "失敗記録" },
  { id: "type-gap", label: "type-gap" },
  { id: "chat", label: "発言" },
] as const;
type Kind = (typeof FILTERS)[number]["id"];
export function noteKind(text: string): Exclude<Kind, "all"> {
  if (/^Chat:\s*/i.test(text)) return "chat";
  if (/^\[failure\]/i.test(text.trimStart())) return "failure";
  if (/^\[type-gap\]/i.test(text.trimStart())) return "type-gap";
  return "finding";
}
const statusName = (s: string) => ({ waiting: "開始待ち", idle: "出番なし", running: "作業中", finished: "終了", stopped: "停止", error: "エラー" })[s] ?? s;
const peer = (agent: string) => `sender ${{ "shiro-2": "peer-two", "shiro-3": "peer-three", "shiro-4": "peer-four" }[agent] ?? ""}`;

/** The latest board of the open conversation, read-only: not an archive of prior turns. */
function BoardView({ board }: { board?: Board }) {
  const [filter, setFilter] = useState<Kind>("all");
  const [query, setQuery] = useState("");
  const tasks = board?.tasks ?? [];
  const gists = board?.gists ?? [];
  const notes = board?.notes ?? [];
  const q = query.trim().toLowerCase();
  const shownNotes = notes.map((n, i) => ({ ...n, i, kind: noteKind(n.text) })).filter((n) =>
    (filter === "all" || n.kind === filter) && `${n.agent} ${n.text}`.toLowerCase().includes(q),
  ).reverse();
  const shownTasks = tasks.filter((t) => `${t.id} ${t.text} ${t.owner ?? ""} ${t.result ?? ""}`.toLowerCase().includes(q));
  return (
    <>
      <p className="context-description">参加者が共有しているタスクとノートです。最新ターンのみ表示し、ノートは最大40件です。</p>
      {board?.statuses && Object.keys(board.statuses).length > 0 && (
        <div className="context-members" aria-label="参加者の状態">
          {Object.entries(board.statuses).map(([agent, status]) => <span className="context-member" key={agent}><span className={peer(agent)}>{agent}</span><span>{statusName(status)}</span></span>)}
        </div>
      )}
      {tasks.length + gists.length + notes.length > 0 && <input type="search" className="context-search" aria-label="共有文脈を検索" placeholder="ノート・タスク・参加者を検索" value={query} onChange={(e) => setQuery(e.target.value)} />}
      <section aria-labelledby="context-tasks">
        <div className="context-section-head"><h2 id="context-tasks">タスクキュー</h2><span>{tasks.filter((t) => t.done).length} / {tasks.length} 完了</span></div>
        {shownTasks.length ? <ul className="context-tasks">{shownTasks.map((task) => (
          <li className="context-card" key={task.id}>
            <div className="context-card-head"><span className={`context-tag ${task.done ? "done" : ""}`}>{task.done ? "完了" : task.owner ? "作業中" : "未着手"}</span><span>{task.owner ?? "担当なし"}</span></div>
            <p>{task.text}</p>
            {task.files && <small>{task.files.join(", ")}</small>}
            {task.result && <div className="context-result"><span>結果</span><p>{task.result}</p></div>}
            <small className="context-task-id">{task.id}</small>
          </li>
        ))}</ul> : <p className="context-empty">{q ? "検索に一致するタスクはありません。" : "まだ共有タスクはありません。"}</p>}
      </section>
      {gists.length > 0 && <section aria-labelledby="context-gists">
        <div className="context-section-head"><h2 id="context-gists">型付き gist</h2><span>{gists.length} 件</span></div>
        <ol className="context-notes">{gists.map((g, i) => ({ ...g, i })).filter((g) => `${g.agent} ${g.type} ${JSON.stringify(g.fields)}`.toLowerCase().includes(q)).reverse().map((g) => (
          <li className="context-card kind-gist" key={g.i}>
            <div className="context-card-head"><span className={peer(g.agent)}>{g.agent}</span><span className="context-tag">{g.type}</span></div>
            <dl className="context-fields">{Object.entries(g.fields).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          </li>
        ))}</ol>
      </section>}
      <section aria-labelledby="context-notes">
        <div className="context-section-head"><h2 id="context-notes">共有ノート</h2><span>{notes.length} 件</span></div>
        {notes.length > 0 && <div className="context-filters" aria-label="ノートの種類">
          {FILTERS.map((f) => <button type="button" key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span>{f.id === "all" ? notes.length : notes.filter((n) => noteKind(n.text) === f.id).length}</span></button>)}
        </div>}
        {filter === "failure" && <p className="context-description">参加者が [failure] として公開したノートだけです。</p>}
        {filter === "type-gap" && <p className="context-description">[type-gap] は v0 の書き方です。いまの type-gap report は「記録」にあります。</p>}
        {shownNotes.length ? <ol className="context-notes">{shownNotes.map((note) => (
          <li className={`context-card kind-${note.kind}`} key={`${note.i}:${note.agent}`}>
            <div className="context-card-head"><span className={peer(note.agent)}>{note.agent}</span><span className="context-tag">{FILTERS.find((f) => f.id === note.kind)?.label}</span></div>
            <p>{note.text}</p>
          </li>
        ))}</ol> : <p className="context-empty">{notes.length ? "条件に一致するノートはありません。" : "まだ共有ノートはありません。"}</p>}
      </section>
    </>
  );
}

/** Three views of what the peers share: this conversation's board, the schema's growth, and the substrate's records. */
export function ContextPage({ board, running, title, id, colonyRev = 0 }: { board?: Board; running: boolean; title: string; id?: string; colonyRev?: number }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("board");
  const colony = useColony(running, colonyRev);
  const undecided = colony.data?.proposals.length ?? 0;
  return (
    <div className="context-page">
      <div className="context-column">
        <header className="context-heading">
          <div><p className="context-eyebrow">{title}</p><h1>共有文脈</h1></div>
          <div className="context-heading-actions">
            <span className={`context-live ${running ? "active" : ""}`}>{running ? "実行中・自動更新" : "最新の保存内容"}</span>
            <CopyButton get={() => JSON.stringify(board ?? { tasks: [], notes: [] }, null, 2)} label="共有文脈をJSONでコピー" />
          </div>
        </header>
        <div className="segmented seg context-seg context-tabs" role="tablist" aria-label="共有文脈の表示" style={{ "--n": TABS.length, "--i": TABS.findIndex((t) => t.id === tab) } as CSSProperties}>
          <span className="seg-thumb" aria-hidden="true" />
          {TABS.map((t) => (
            <button type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} key={t.id} onClick={() => setTab(t.id)}>
              {t.label}{t.id === "schema" && undecided > 0 && <span className="context-badge" aria-label={`未決の提案 ${undecided} 件`}>{undecided}</span>}
            </button>
          ))}
        </div>
        <div className="context-panel" role="tabpanel" key={tab}>
          {tab === "board" && <BoardView board={board} />}
          {tab === "schema" && <SchemaView {...colony} />}
          {tab === "records" && <RecordsView {...colony} conv={id} />}
        </div>
      </div>
    </div>
  );
}
