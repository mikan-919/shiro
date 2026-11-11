import type { CSSProperties } from "react";
import { CircleDashed } from "lucide-react";
import "./empty.css";

/** Position in the entrance sequence (see empty.css). */
const order = (i: number) => ({ "--i": i }) as CSSProperties;

const SUGGESTIONS = [
  "このリポジトリの構成を説明して",
  "未コミットの変更を確認して",
  "TODO コメントを探して一覧にして",
  "今日やることを整理したい",
];

export function Empty({ needsLogin, onLogin, onSuggest }: { needsLogin: boolean; onLogin: () => void; onSuggest: (text: string) => void }) {
  return (
    <div className="empty">
      <CircleDashed className="ring" style={order(0)} strokeWidth={1.7} aria-hidden="true" />
      {needsLogin ? (
        <div className="login" style={order(1)}>
          <h2 className="greeting">はじめに、ChatGPT のアカウントでログインしてください</h2>
          <p>shiro は ChatGPT のプランに含まれる Codex の利用枠で応答します。</p>
          <button type="button" className="btn primary large" onClick={onLogin}>ChatGPT でログイン</button>
        </div>
      ) : (
        <>
          <h2 className="greeting" style={order(1)}>何から始めますか</h2>
          <div className="suggestions" style={order(2)}>
            {SUGGESTIONS.map((s) => (
              <button type="button" key={s} className="chip" onClick={() => onSuggest(s)}>
                {s}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
