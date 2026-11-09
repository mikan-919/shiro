import { Children, memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "./ui";
import { reducedMotion } from "./motion";
import "./markdown.css";

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const child = Children.toArray(children)[0] as ReactElement<{ className?: string }> | undefined;
  const lang = /language-([\w+#-]+)/.exec(child?.props?.className ?? "")?.[1];
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang ?? "テキスト"}</span>
        <CopyButton get={() => ref.current?.innerText ?? ""} label="コードをコピー" />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};
const REMARK = [remarkGfm];
const REHYPE = [rehypeHighlight];

// Model output is rendered without raw HTML (react-markdown's default), so it cannot inject script.
export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
      {text}
    </Markdown>
  );
});

/**
 * Streams text at an even pace instead of in network-sized bursts. The revealed length eases toward the
 * received length (closing 1 - e^(-dt/220ms) of the gap per frame) with a floor of one character per 12ms,
 * so a large burst never trails far behind. Text that is not live renders in full at once.
 */
export function SmoothMd({ text, live }: { text: string; live: boolean }) {
  const [shown, setShown] = useState(() => (live ? 0 : text.length));
  const pos = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) return void setShown((pos.current = text.length));
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const gap = text.length - pos.current;
      if (gap <= 0) return;
      const dt = now - last;
      last = now;
      pos.current = Math.min(text.length, pos.current + Math.max(gap * (1 - Math.exp(-dt / 220)), dt / 12));
      setShown(Math.floor(pos.current));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return <Md text={shown >= text.length ? text : text.slice(0, shown)} />;
}
