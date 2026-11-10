import { useState } from "react";
import { assistantText, MODELS, type AssistantMessage, type ReasoningPart, type ToolPart, type UserMessage } from "../shared";
import type { Conversation } from "./sync";
import { CopyButton, Icon, IconButton, usePopover } from "./ui";
import { useFollowBottom } from "./motion";
import { Md } from "./markdown";
import { StepChain } from "./steps";
import "./thread.css";

const modelName = (id: string) => MODELS.find((m) => m.id === id)?.name ?? id;
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function Reaction({ emoji }: { emoji?: string }) {
  return emoji ? <span className="reaction" aria-label={`リアクション ${emoji}`}>{emoji}</span> : null;
}

function UserRow({ m, fresh, busy, onEdit, onImage }: { m: UserMessage; fresh: boolean; busy: boolean; onEdit: (text: string) => void; onImage: (src: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  if (editing)
    return (
      <div className="row me editing">
        <textarea className="edit-box" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={Math.min(10, draft.split("\n").length + 1)} />
        <div className="edit-actions">
          <button type="button" className="btn" onClick={() => (setEditing(false), setDraft(m.text))}>キャンセル</button>
          <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={() => (setEditing(false), onEdit(draft))}>送信</button>
        </div>
      </div>
    );
  return (
    <div className={`row me ${fresh ? "is-new" : ""}`}>
      {m.images.length > 0 && (
        <div className="user-images">
          {m.images.map((src, i) => (
            <button type="button" key={i} className="thumb" onClick={() => onImage(src)} aria-label="画像を拡大">
              <img src={src} alt="" />
            </button>
          ))}
        </div>
      )}
      <div className="bubble-line">
        <div className="row-tools">
          <CopyButton get={() => m.text} />
          <IconButton icon="pencil" label="編集して送り直す" small disabled={busy} onClick={() => setEditing(true)} />
        </div>
        {m.text && (
          <div className="bubble">
            {m.text}
            <Reaction emoji={m.reaction} />
          </div>
        )}
      </div>
    </div>
  );
}

/** One of the agent's bubbles. `onReact` is absent for bubbles that cannot take a reaction (old plain-text replies). */
function Bubble({ text, reaction, onReact }: { text: string; reaction?: string; onReact?: (emoji: string | null) => void }) {
  const pick = usePopover();
  return (
    <div className="row them">
      <div className="bubble-line">
        <div className="bubble">
          <div className="prose"><Md text={text} /></div>
          <Reaction emoji={reaction} />
        </div>
        <div className="row-tools" ref={pick.ref}>
          {onReact && <IconButton icon="smile" label="リアクションを付ける" small onClick={() => pick.setOpen(!pick.open)} />}
          <CopyButton get={() => text} />
          {pick.mounted && onReact && (
            <div className={`popover reaction-pop ${pick.leaving ? "leaving" : ""}`} style={pick.style} role="menu" aria-label="リアクション">
              {REACTIONS.map((e) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={e === reaction}
                  key={e}
                  className={e === reaction ? "on" : ""}
                  onClick={() => (pick.setOpen(false), onReact(e === reaction ? null : e))}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type Block =
  | { kind: "bubble"; key: string; text: string; reaction?: string; sayId?: string }
  | { kind: "steps"; key: string; parts: (ReasoningPart | ToolPart)[] };

/** Bubbles stand alone; consecutive reasoning and tool calls between them form one chain. Plain text is not shown. */
function blocks(m: AssistantMessage): Block[] {
  const out: Block[] = [];
  m.parts.forEach((p, i) => {
    if (p.type === "say") return void out.push({ kind: "bubble", key: p.id, text: p.text, reaction: p.reaction, sayId: p.id });
    if (p.type === "text") return;
    if (p.type === "reasoning" && !p.text.trim()) return;
    const last = out.at(-1);
    if (last?.kind === "steps") last.parts.push(p);
    else out.push({ kind: "steps", parts: [p], key: `s${i}` });
  });
  return out;
}

function AssistantRows({ m, fresh, isLast, busy, onApprove, onReact, onRegenerate }: {
  m: AssistantMessage; fresh: boolean; isLast: boolean; busy: boolean;
  onApprove: (call: string, ok: boolean) => void; onReact: (bubble: string, emoji: string | null) => void; onRegenerate: () => void;
}) {
  const live = m.status === "streaming";
  const tail = m.parts.at(-1);
  // Steps are hidden for now, so the dots stand for all work in progress; only a pending approval shows its own card.
  const typing = !m.agent && live && !(tail?.type === "tool" && tail.status === "awaiting");
  const content = blocks(m);
  const visible = content.some((b) => b.kind === "bubble" || b.parts.some((p) => p.type === "tool" && p.status === "awaiting"));
  if (m.agent && !visible && m.status !== "error" && m.status !== "stopped") return null;
  return (
    <div className={`msg ${fresh ? "is-new" : ""}`}>
      {m.agent && <span className={`sender ${m.agent === "shiro-2" ? "peer-two" : m.agent === "shiro-3" ? "peer-three" : m.agent === "shiro-4" ? "peer-four" : ""}`}>{m.agent}</span>}
      {content.map((b) =>
        b.kind === "bubble" ? (
          <Bubble key={b.key} text={b.text} reaction={b.reaction} onReact={b.sayId ? (e) => onReact(b.sayId!, e) : undefined} />
        ) : (
          <StepChain key={b.key} parts={b.parts} onApprove={onApprove} />
        ),
      )}
      {typing && (
        <div className="row them" aria-label="入力中">
          <div className="bubble typing"><i /><i /><i /></div>
        </div>
      )}
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
      {isLast && !live && !busy && (
        <div className="msg-foot">
          {assistantText(m) && <CopyButton get={() => assistantText(m)} label="返信をまとめてコピー" />}
          <IconButton icon="retry" label="返信を作り直す" small disabled={busy} onClick={onRegenerate} />
          <span className="model-tag">{modelName(m.model)}</span>
        </div>
      )}
    </div>
  );
}

export function Thread({ conv, known, onApprove, onReact, onEdit, onRegenerate, onImage }: {
  conv: Conversation; known: Set<string>;
  onApprove: (call: string, ok: boolean) => void; onReact: (bubble: string, emoji: string | null) => void;
  onEdit: (from: UserMessage, text: string) => void; onRegenerate: () => void; onImage: (src: string) => void;
}) {
  const follow = useFollowBottom<HTMLDivElement, HTMLDivElement>({ tau: 200, near: 96 });
  const busy = conv.meta.running;
  const participants = conv.messages.filter((m): m is AssistantMessage => m.role === "assistant" && !!m.agent && m.status === "streaming");
  const lastAssistant = conv.messages.findLastIndex((m) => m.role === "assistant");

  return (
    <div className="thread" {...follow.scroller}>
      <div className="column" ref={follow.content}>
        {conv.messages.map((m, i) =>
          m.role === "user" ? (
            <UserRow key={m.id} m={m} fresh={!known.has(m.id)} busy={busy} onEdit={(t) => onEdit(m, t)} onImage={onImage} />
          ) : (
            <AssistantRows key={m.id} m={m} fresh={!known.has(m.id)} isLast={i === lastAssistant} busy={busy} onApprove={onApprove} onReact={onReact} onRegenerate={onRegenerate} />
          ),
        )}
        {busy && participants.length > 0 && (
          <div className="team-presence" role="status" aria-label="参加者の状態">
            {participants.map((m) => (
              <span key={m.id} className={`sender ${m.agent === "shiro-2" ? "peer-two" : m.agent === "shiro-3" ? "peer-three" : m.agent === "shiro-4" ? "peer-four" : ""}`}>
                {m.agent}
                {m.parts.some((p) => p.type === "tool" && p.status === "awaiting") ? (
                  <span>承認待ち</span>
                ) : (
                  <span className="bubble typing" aria-label="入力中"><i /><i /><i /></span>
                )}
              </span>
            ))}
          </div>
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
