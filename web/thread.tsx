import { useState } from "react";
import { assistantText, MODELS, type AssistantMessage, type Part, type ReasoningPart, type ToolPart, type UserMessage } from "../shared";
import type { Conversation } from "./sync";
import { CopyButton, Icon, IconButton } from "./ui";
import { useFollowBottom } from "./motion";
import { SmoothMd } from "./markdown";
import { StepChain } from "./steps";
import "./thread.css";

const modelName = (id: string) => MODELS.find((m) => m.id === id)?.name ?? id;

function UserBubble({ m, fresh, busy, onEdit, onImage }: { m: UserMessage; fresh: boolean; busy: boolean; onEdit: (text: string) => void; onImage: (src: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  if (editing)
    return (
      <div className="msg user editing">
        <textarea className="edit-box" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={Math.min(10, draft.split("\n").length + 1)} />
        <div className="edit-actions">
          <button type="button" className="btn" onClick={() => (setEditing(false), setDraft(m.text))}>キャンセル</button>
          <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={() => (setEditing(false), onEdit(draft))}>送信</button>
        </div>
      </div>
    );
  return (
    <div className={`msg user ${fresh ? "is-new" : ""}`}>
      {m.images.length > 0 && (
        <div className="user-images">
          {m.images.map((src, i) => (
            <button type="button" key={i} className="thumb" onClick={() => onImage(src)} aria-label="画像を拡大">
              <img src={src} alt="" />
            </button>
          ))}
        </div>
      )}
      {m.text && <div className="bubble">{m.text}</div>}
      <div className="msg-actions">
        <CopyButton get={() => m.text} />
        <IconButton icon="pencil" label="編集して送り直す" small disabled={busy} onClick={() => setEditing(true)} />
      </div>
    </div>
  );
}

type Block = { kind: "text"; text: string; key: string } | { kind: "steps"; parts: (ReasoningPart | ToolPart)[]; key: string };

function blocks(parts: Part[]): Block[] {
  const out: Block[] = [];
  parts.forEach((p, i) => {
    if (p.type === "text") return void out.push({ kind: "text", text: p.text, key: `t${i}` });
    if (p.type === "reasoning" && !p.text.trim()) return;
    const last = out.at(-1);
    if (last?.kind === "steps") last.parts.push(p);
    else out.push({ kind: "steps", parts: [p], key: `s${i}` });
  });
  return out;
}

function AssistantBody({ m, fresh, isLast, busy, onApprove, onRegenerate }: {
  m: AssistantMessage; fresh: boolean; isLast: boolean; busy: boolean;
  onApprove: (tool: string, ok: boolean) => void; onRegenerate: () => void;
}) {
  const tail = m.parts.at(-1);
  const waiting =
    m.status === "streaming" &&
    (!tail || (tail.type === "reasoning" && tail.done) || (tail.type === "tool" && tail.status !== "running" && tail.status !== "awaiting"));
  const text = assistantText(m);
  return (
    <div className={`msg assistant ${fresh ? "is-new" : ""}`}>
      {blocks(m.parts).map((b) =>
        b.kind === "text" ? (
          <div key={b.key} className="prose"><SmoothMd text={b.text} live={m.status === "streaming"} /></div>
        ) : (
          <StepChain key={b.key} parts={b.parts} onApprove={onApprove} />
        ),
      )}
      {waiting && <div className="tip" aria-label="応答を待っています"><span /></div>}
      {m.status === "stopped" && <p className="note">生成を停止しました</p>}
      {m.status === "error" && (
        <div className="error-box" role="alert">
          <Icon name="alert" size={16} />
          <div>
            <p>応答を生成できませんでした。</p>
            <p className="error-detail">{m.error}</p>
          </div>
          {isLast && <button type="button" className="btn" disabled={busy} onClick={onRegenerate}>もう一度送る</button>}
        </div>
      )}
      {m.status !== "streaming" && (
        <div className="msg-actions">
          {text && <CopyButton get={() => text} />}
          {isLast && <IconButton icon="retry" label="回答を作り直す" small disabled={busy} onClick={onRegenerate} />}
          <span className="model-tag">{modelName(m.model)}</span>
        </div>
      )}
    </div>
  );
}

export function Thread({ conv, known, onApprove, onEdit, onRegenerate, onImage }: {
  conv: Conversation; known: Set<string>;
  onApprove: (tool: string, ok: boolean) => void; onEdit: (from: UserMessage, text: string) => void;
  onRegenerate: () => void; onImage: (src: string) => void;
}) {
  const follow = useFollowBottom<HTMLDivElement, HTMLDivElement>({ tau: 200, near: 96 });
  const busy = conv.meta.running;
  const lastAssistant = conv.messages.findLastIndex((m) => m.role === "assistant");

  return (
    <div className="thread" {...follow.scroller}>
      <div className="column" ref={follow.content}>
        {conv.messages.map((m, i) =>
          m.role === "user" ? (
            <UserBubble key={m.id} m={m} fresh={!known.has(m.id)} busy={busy} onEdit={(t) => onEdit(m, t)} onImage={onImage} />
          ) : (
            <AssistantBody key={m.id} m={m} fresh={!known.has(m.id)} isLast={i === lastAssistant} busy={busy} onApprove={onApprove} onRegenerate={onRegenerate} />
          ),
        )}
      </div>
      {follow.away && (
        <button type="button" className="to-latest" onClick={follow.toBottom}>
          <Icon name="down" size={16} />
          最新へ
        </button>
      )}
    </div>
  );
}
