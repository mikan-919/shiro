import { useEffect, useMemo, useState, type ReactNode } from "react";
import "./empty.css";

/** A fairy ring of hyphae: threads start on a circle and branch outward, the centre left bare. */
function ringPaths() {
  let s = 9;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const paths: { d: string; o: number; w: number; delay: number }[] = [];
  const C = 140;
  const grow = (x: number, y: number, a: number, len: number, depth: number, delay: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    const steps = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < steps; i++) {
      // Bend gently, and keep heading away from the centre like a ring front does.
      const out = Math.atan2(y - C, x - C);
      a += (rnd() - 0.5) * 0.9 + Math.atan2(Math.sin(out - a), Math.cos(out - a)) * 0.15;
      const px = x, py = y;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      d += ` Q${(px + x) / 2 + (rnd() - 0.5) * 3} ${(py + y) / 2 + (rnd() - 0.5) * 3} ${x.toFixed(1)} ${y.toFixed(1)}`;
      if (depth < 2 && rnd() < 0.28) grow(x, y, a + (rnd() < 0.5 ? -0.9 : 0.9), len * 0.7, depth + 1, delay + (i + 1) * 0.14);
    }
    paths.push({ d, o: 0.9 - depth * 0.28 - rnd() * 0.25, w: 1.1 - depth * 0.32, delay });
  };
  const n = 46;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.1;
    const r = 58 + rnd() * 12;
    grow(C + Math.cos(a) * r, C + Math.sin(a) * r, a + (rnd() - 0.5) * 0.6, 5 + rnd() * 3, 0, rnd() * 0.6);
  }
  return paths;
}

// The ring grows once per page load. New chats (often opened with Ctrl+Shift+O) show it already grown.
let ringGrown = false;

function Ring() {
  const paths = useMemo(ringPaths, []);
  const [grow] = useState(() => !ringGrown);
  useEffect(() => void (ringGrown = true), []);
  return (
    <svg className={`ring ${grow ? "grow" : ""}`} viewBox="0 0 280 280" aria-hidden="true">
      {paths.map((p, i) => (
        <path key={i} d={p.d} pathLength={1} strokeWidth={p.w} style={{ opacity: Math.max(p.o, 0.15), animationDelay: `${p.delay}s` }} />
      ))}
    </svg>
  );
}

const SUGGESTIONS = [
  "このリポジトリの構成を説明して",
  "未コミットの変更を確認して",
  "TODO コメントを探して一覧にして",
  "今日やることを整理したい",
];

/** The new-chat screen: an invitation to log in, or a composer with suggestions to start from. */
export function Empty({ needsLogin, composer, onLogin, onSuggest }: {
  needsLogin: boolean; composer: ReactNode; onLogin: () => void; onSuggest: (text: string) => void;
}) {
  return (
    <div className="empty">
      <Ring />
      {needsLogin ? (
        <div className="login">
          <h2 className="greeting">はじめに、ChatGPT のアカウントでログインしてください</h2>
          <p>shiro は ChatGPT のプランに含まれる Codex の利用枠で応答します。</p>
          <button type="button" className="btn primary large" onClick={onLogin}>ChatGPT でログイン</button>
        </div>
      ) : (
        <>
          <h2 className="greeting">何から始めますか</h2>
          <div className="empty-composer">{composer}</div>
          <div className="suggestions">
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
