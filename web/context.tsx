import { useState } from "react";
import type { Board } from "../shared";
import { CopyButton } from "./ui";
import "./context.css";

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

/** A read-only view of the latest board, not an archive of all prior turns. */
export function ContextPage({ board, running, title }: { board?: Board; running: boolean; title: string }) {
  const [filter, setFilter] = useState<Kind>("all");
  const [query, setQuery] = useState("");
  const tasks = board?.tasks ?? [];
  const notes = board?.notes ?? [];
  const q = query.trim().toLowerCase();
  const shownNotes = notes.map((n, i) => ({ ...n, i, kind: noteKind(n.text) })).filter((n) =>
    (filter === "all" || n.kind === filter) && `${n.agent} ${n.text}`.toLowerCase().includes(q),
  ).reverse();
  const shownTasks = tasks.filter((t) => `${t.id} ${t.text} ${t.owner ?? ""} ${t.result ?? ""}`.toLowerCase().includes(q));
  const completed = tasks.filter((t) => t.done).length;
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
        <p className="context-description">エージェント同士が共有しているタスクとノートです。最新ターンのみ表示し、次の入力で新しいボードに切り替わります。ノートは最大40件で、過去ターンの全記録や非公開の推論・ツール履歴は含みません。</p>
        {board?.statuses && Object.keys(board.statuses).length > 0 && (
          <div className="context-members" aria-label="参加者の状態">
            {Object.entries(board.statuses).map(([agent, status]) => (
              <span className="context-member" key={agent}><span className={`sender ${agent === "shiro-2" ? "peer-two" : agent === "shiro-3" ? "peer-three" : agent === "shiro-4" ? "peer-four" : ""}`}>{agent}</span><span>{statusName(status)}</span></span>
            ))}
          </div>
        )}
        <input type="search" className="context-search" aria-label="共有文脈を検索" placeholder="ノート・タスク・参加者を検索" value={query} onChange={(e) => setQuery(e.target.value)} />
        <section aria-labelledby="context-tasks">
          <div className="context-section-head"><h2 id="context-tasks">タスクキュー</h2><span>{completed} / {tasks.length} 完了</span></div>
          {shownTasks.length ? <ul className="context-tasks">{shownTasks.map((task) => (
            <li className="context-card" key={task.id}>
              <div className="context-card-head"><span className={`context-tag ${task.done ? "done" : ""}`}>{task.done ? "完了" : task.owner ? "作業中" : "未着手"}</span><span>{task.owner ?? "担当なし"}</span></div>
              <p>{task.text}</p>
              {task.result && <div className="context-result"><span>結果</span><p>{task.result}</p></div>}
              <small className="context-task-id">{task.id}</small>
            </li>
          ))}</ul> : <p className="context-empty">{q ? "検索に一致するタスクはありません。" : "まだ共有タスクはありません。"}</p>}
        </section>
        <section aria-labelledby="context-notes">
          <div className="context-section-head"><h2 id="context-notes">共有ノート</h2><span>{notes.length} 件・新しい順</span></div>
          <div className="context-filters" aria-label="ノートの種類">
            {FILTERS.map((f) => <button type="button" key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span>{f.id === "all" ? notes.length : notes.filter((n) => noteKind(n.text) === f.id).length}</span></button>)}
          </div>
          {(filter === "failure" || filter === "type-gap") && <p className="context-description">{filter === "failure" ? "[failure] として公開されたノートです。すべてのツールエラーが自動で記録されるわけではありません。" : "[type-gap] は表現の不足を報告する暫定ラベルで、採用済みのスキーマ型ではありません。"}</p>}
          {shownNotes.length ? <ol className="context-notes">{shownNotes.map((note) => (
            <li className={`context-card kind-${note.kind}`} key={`${note.i}:${note.agent}`}>
              <div className="context-card-head"><span className={`sender ${note.agent === "shiro-2" ? "peer-two" : note.agent === "shiro-3" ? "peer-three" : note.agent === "shiro-4" ? "peer-four" : ""}`}>{note.agent}</span><span className="context-tag">{FILTERS.find((f) => f.id === note.kind)?.label}</span></div>
              <p>{note.text}</p>
            </li>
          ))}</ol> : <p className="context-empty">{notes.length ? "条件に一致するノートはありません。" : "まだ共有ノートはありません。公開されるとここに表示されます。"}</p>}
        </section>
      </div>
    </div>
  );
}
