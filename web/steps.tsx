// Reasoning and tool calls, shown as one thread of steps.
import { useLayoutEffect, useState, type ReactNode } from "react";
import type { Judge, ReasoningPart, ToolPart, ToolView } from "../shared";
import { Collapse, Icon } from "./ui";
import { useFollowBottom } from "./motion";
import { Md } from "./markdown";
import "./steps.css";

const pct = (v?: number) => (v === undefined ? "-" : `${Math.round(v * 100)}%`);
const judgeDetail = (j: Judge) => `読み取りのみ ${pct(j.readOnly)}、取り消せる操作 ${pct(j.reversible)}、依頼に沿う ${pct(j.servesTask)}`;

function ReasoningStep({ p }: { p: ReasoningPart }) {
  const [open, setOpen] = useState(true);
  const heading = [...p.text.matchAll(/\*\*(.+?)\*\*/g)].at(-1)?.[1];
  return (
    <li className={`step ${p.done ? "" : "is-live"}`}>
      <button type="button" className="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-node"><Icon name="ring" size={14} /></span>
        <span className="step-verb">{p.done ? "考えた過程" : "考えています"}</span>
        {!p.done && heading && <span className="step-target">{heading}</span>}
        <span className={`step-caret ${open ? "open" : ""}`}><Icon name="chevron" size={14} /></span>
      </button>
      <Collapse open={open}>
        <div className="step-body reasoning">
          <Md text={p.text} />
        </div>
      </Collapse>
    </li>
  );
}

function Detail({ d }: { d: NonNullable<ToolView["detail"]> }) {
  if (d.kind === "chips") return <ul className="chips">{d.items.map((q) => <li key={q}>{q}</li>)}</ul>;
  if (d.kind === "code") return <pre className="cmd">{d.text}</pre>;
  return (
    <pre className="diff">
      {d.before.split("\n").map((l, i) => <span key={`a${i}`} className="del">{l}{"\n"}</span>)}
      {d.after.split("\n").map((l, i) => <span key={`b${i}`} className="add">{l}{"\n"}</span>)}
    </pre>
  );
}

const STATUS: Record<ToolPart["status"], ReactNode> = {
  judging: <span className="badge judging"><span className="spin" />自動判定中</span>,
  running: <span className="spin" aria-label="実行中" />,
  awaiting: <span className="badge wait">承認待ち</span>,
  done: <span className="ok"><Icon name="check" size={14} /></span>,
  denied: <span className="badge muted">拒否しました</span>,
  error: <span className="badge bad">失敗</span>,
};

function ToolStep({ p }: { p: ToolPart }) {
  const [open, setOpen] = useState(false);
  const { view } = p;
  // A pending approval shows the command in its card; a denied call has no result to sum up.
  const summary = p.status === "awaiting" || p.status === "denied" ? undefined : p.summary;
  return (
    <li className={`step tool-${p.status}`}>
      <button type="button" className="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-node"><Icon name={view.icon} size={14} /></span>
        <span className="step-verb">{view.label}</span>
        <span className="step-target mono">{view.target}</span>
        {p.judge?.ok && (
          <span className="badge auto" title={judgeDetail(p.judge)}>
            <Icon name="shield" size={12} />
            自動で許可
          </span>
        )}
        <span className="step-status">{STATUS[p.status]}</span>
        <span className={`step-caret ${open ? "open" : ""}`}><Icon name="chevron" size={14} /></span>
      </button>
      {summary && !open && <p className={`step-preview ${p.status === "error" ? "bad" : ""}`}>{summary}</p>}
      <Collapse open={open}>
        <div className="step-body">
          {p.judge && p.status !== "awaiting" && (
            <p className="judge-line">
              <Icon name="shield" size={13} />
              {p.judge.ok ? "Jev の判定で自動的に許可しました。" : `自動では許可しませんでした。${p.judge.reason ?? ""}。`}
              {p.judge.by === "jev" && <span className="scores">{judgeDetail(p.judge)}</span>}
            </p>
          )}
          {view.detail && <Detail d={view.detail} />}
          {p.output !== undefined &&
            (view.markdown && p.status === "done" ? (
              <div className="out-md"><Md text={p.output} /></div>
            ) : (
              <pre className={`out ${p.status === "error" ? "bad" : ""}`}>{p.output}</pre>
            ))}
        </div>
      </Collapse>
    </li>
  );
}

function ApproveCard({ p, onApprove }: { p: ToolPart; onApprove: (ok: boolean) => void }) {
  return (
    <Collapse open={p.status === "awaiting"}>
      <div className="approve" role="group" aria-label="コマンドの実行の承認">
        <p>このコマンドを実行しますか？</p>
        {p.judge && !p.judge.ok && (
          <p className="approve-why">
            自動では許可しませんでした。{p.judge.reason}。
            {p.judge.by === "jev" && <span className="scores">{judgeDetail(p.judge)}</span>}
          </p>
        )}
        <pre className="cmd">{`$ ${p.view.request}`}</pre>
        <div className="approve-actions">
          <button type="button" className="btn primary" onClick={() => onApprove(true)}>実行する</button>
          <button type="button" className="btn" onClick={() => onApprove(false)}>拒否する</button>
        </div>
      </div>
    </Collapse>
  );
}

/**
 * Reasoning and tool calls in one bounded, scrollable thread. New steps arrive at the bottom and the list
 * glides after them, so a long run of tool calls stays a fixed height instead of pushing the answer away.
 * Approval cards sit below it, so a pending one is never scrolled out of view or faded at the edge.
 */
export function StepChain({ parts, onApprove }: { parts: (ReasoningPart | ToolPart)[]; onApprove: (tool: string, ok: boolean) => void }) {
  const follow = useFollowBottom<HTMLDivElement, HTMLOListElement>({ tau: 1000, near: 24, onScroll: () => measure() });
  const [edges, setEdges] = useState({ top: false, bottom: false });
  function measure() {
    const el = follow.scroller.ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }
  useLayoutEffect(measure, [parts]);

  return (
    <>
      <div {...follow.scroller} className={`steps-scroll ${edges.top ? "fade-top" : ""} ${edges.bottom ? "fade-bottom" : ""}`}>
        <ol className="steps" ref={follow.content}>
          {parts.map((p, i) => (p.type === "reasoning" ? <ReasoningStep key={i} p={p} /> : <ToolStep key={p.id} p={p} />))}
        </ol>
      </div>
      {parts.map((p) => p.type === "tool" && p.view.request !== undefined && <ApproveCard key={p.id} p={p} onApprove={(ok) => onApprove(p.id, ok)} />)}
    </>
  );
}
