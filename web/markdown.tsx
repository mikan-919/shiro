import { Children, memo, useRef, type ReactElement, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "./ui";
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
