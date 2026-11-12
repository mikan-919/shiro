import { useEffect, useRef, type CSSProperties } from "react";
import { CircleDashed } from "lucide-react";
import { approach, reducedMotion } from "./motion";
import "./empty.css";

/** Position in the entrance sequence (see empty.css). */
const order = (i: number) => ({ "--i": i }) as CSSProperties;

const SUGGESTIONS = [
  "このリポジトリの構成を説明して",
  "未コミットの変更を確認して",
  "TODO コメントを探して一覧にして",
  "今日やることを整理したい",
];

/** The ring leans a few pixels toward the pointer and turns with it, catching up by lerp rather than tracking it exactly. */
function useLean() {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || !matchMedia("(hover: hover)").matches) return;
    let raf = 0, last = 0, x = 0, y = 0, tx = 0, ty = 0;
    const step = (now: number) => {
      x = approach(x, tx, now - last, 160);
      y = approach(y, ty, now - last, 160);
      last = now;
      el.style.translate = `${x * 12}px ${y * 12}px`;
      el.style.rotate = `${x * 24}deg`;
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.002 ? requestAnimationFrame(step) : 0;
    };
    const move = (e: PointerEvent) => {
      tx = (e.clientX / innerWidth) * 2 - 1;
      ty = (e.clientY / innerHeight) * 2 - 1;
      if (!raf) (last = performance.now()), (raf = requestAnimationFrame(step));
    };
    addEventListener("pointermove", move);
    return () => (removeEventListener("pointermove", move), cancelAnimationFrame(raf));
  }, []);
  return ref;
}

export function Empty({ needsLogin, onLogin, onSuggest }: { needsLogin: boolean; onLogin: () => void; onSuggest: (text: string) => void }) {
  const ring = useLean();
  return (
    <div className="empty">
      <CircleDashed ref={ring} className="ring" style={order(0)} strokeWidth={1.7} aria-hidden="true" />
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
