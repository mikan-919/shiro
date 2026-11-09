import {
  Children, StrictMode, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ReactElement, type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { apply, type Account, type Judge, type AssistantMessage, type ConvMeta, type Effort, type Message, type Part, type Push, type UserMessage } from "../shared";

// ─── utilities ────────────────────────────────────────────────────────────

type ServerState = {
  account: Account | null;
  cwd: string;
  models: { id: string; name: string }[];
  efforts: { id: Effort; name: string }[];
  defaultModel: string;
  jev: boolean;
};
type ToolPart = Extract<Part, { type: "tool" }>;
type ReasoningPart = Extract<Part, { type: "reasoning" }>;

async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `サーバーがエラーを返しました（${r.status}）`);
  return j as T;
}

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

function useStored<T>(key: string, init: T) {
  const [v, setV] = useState<T>(() => store.get(key, init));
  const set = useCallback((n: T) => (setV(n), store.set(key, n)), [key]);
  return [v, set] as const;
}

const idFromPath = () => /^\/c\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;

function groupLabel(t: number) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const d = new Date(t);
  const diff = (day(new Date()) - day(d)) / 86_400_000;
  if (diff < 1) return "今日";
  if (diff < 2) return "昨日";
  if (diff < 7) return "過去7日間";
  if (diff < 30) return "過去30日間";
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

const parseArgs = (s: string): Record<string, string> => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

/** Shrinks pasted or dropped images so a screenshot does not become a multi-megabyte request. */
async function toDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const imageFiles = (list: FileList | File[] | null | undefined) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reads an easing token from style.css so JS-driven motion (WAAPI) uses the same curves as CSS. */
const cssEase = (name: "--ease-out" | "--ease-in-out") => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "ease-out";

/** Keeps an element mounted for `ms` after `open` turns false, so it can play its exit. */
function usePresence(open: boolean, ms = 120) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return void setMounted(true);
    if (reducedMotion()) return void setMounted(false);
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, leaving: !open && mounted };
}

/**
 * Keeps a scroll container pinned to its bottom while content grows. Instead of jumping, it glides with
 * frame-rate independent linear interpolation: each frame closes 1 - e^(-dt/tau) of the remaining distance,
 * reading the latest target every frame, so new content during a glide just extends it.
 * A wheel or touch scroll by the user stops the glide; scrolling back near the bottom pins it again.
 */
function useFollowBottom<T extends HTMLElement>(
  dep: unknown,
  { near = 24, tau = 100, resetKey, observe = false }: { near?: number; tau?: number; resetKey?: unknown; observe?: boolean } = {},
) {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const pos = useRef(0);
  const raf = useRef(0);
  const [away, setAway] = useState(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  const glide = useCallback(() => {
    const el = ref.current;
    if (!el || raf.current) return;
    if (reducedMotion()) return void (el.scrollTop = el.scrollHeight);
    pos.current = el.scrollTop;
    let last = performance.now();
    const step = (now: number) => {
      const target = el.scrollHeight - el.clientHeight;
      pos.current += (target - pos.current) * (1 - Math.exp(-(now - last) / tau));
      last = now;
      if (Math.abs(target - pos.current) < 0.5) {
        el.scrollTop = target;
        raf.current = 0;
        return;
      }
      el.scrollTop = pos.current;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [tau]);

  // Opening a conversation lands on its end at once; gliding there from the top would be noise.
  useLayoutEffect(() => {
    stop();
    stick.current = true;
    setAway(false);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [resetKey, stop]);
  useLayoutEffect(() => {
    if (stick.current) glide();
  }, [dep, glide]);
  useEffect(() => stop, [stop]);
  // Content can also grow between data updates (text revealed frame by frame, panels opening).
  useEffect(() => {
    const content = observe ? ref.current?.firstElementChild : null;
    if (!content) return;
    const ro = new ResizeObserver(() => stick.current && glide());
    ro.observe(content);
    return () => ro.disconnect();
  }, [observe, glide, resetKey]);

  const onScroll = () => {
    const el = ref.current;
    if (!el || raf.current) return; // our own frames
    const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < near;
    stick.current = isNear;
    setAway(!isNear);
  };
  const toBottom = () => {
    stick.current = true;
    setAway(false);
    glide();
  };
  return { ref, away, onScroll, onUserScroll: stop, toBottom };
}

// ─── icons ────────────────────────────────────────────────────────────────

const ICONS: Record<string, ReactNode> = {
  compose: <><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M9 3v18" /></>,
  clip: <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  up: <><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></>,
  down: <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M4 16V5a1 1 0 0 1 1-1h11" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  pencil: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  retry: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /></>,
  dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2m-7.1-17.1 1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  ring: <circle cx="12" cy="12" r="7" strokeDasharray="2.2 2.6" />,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
};

function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function IconButton({ icon, label, onClick, className = "", disabled, size }: { icon: string; label: string; onClick?: () => void; className?: string; disabled?: boolean; size?: number }) {
  return (
    <button type="button" className={`icon-btn ${className}`} onClick={onClick} aria-label={label} title={label} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

function CopyButton({ get, label = "コピー" }: { get: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      icon={done ? "check" : "copy"}
      label={done ? "コピーしました" : label}
      size={16}
      onClick={async () => {
        await navigator.clipboard.writeText(get());
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    />
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

// ─── the colony ring (empty state) ────────────────────────────────────────

/** A fairy ring of hyphae: threads start on a circle and branch outward, the centre left bare. */
function useRingPaths() {
  return useMemo(() => {
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
  }, []);
}

// The ring grows once per page load. New chats (often opened with Ctrl+Shift+O) show it already grown.
let ringGrown = false;

function Ring() {
  const paths = useRingPaths();
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

// ─── markdown ─────────────────────────────────────────────────────────────

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

/**
 * Streams text at an even pace instead of in network-sized bursts. The revealed length eases toward the
 * received length (closing 1 - e^(-dt/220ms) of the gap per frame) with a floor of one character per 12ms,
 * so a large burst never trails far behind. History renders in full at once.
 */
function SmoothMd({ text, live }: { text: string; live: boolean }) {
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

const MD_COMPONENTS: Components = {
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
const Md = memo(function Md({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={MD_COMPONENTS}>
      {text}
    </Markdown>
  );
});

// ─── steps: reasoning and tool calls, joined by one thread ────────────────

/**
 * Opens and closes by animating grid rows 0fr ↔ 1fr (the one place height may animate: an accordion).
 * Mounts on open and keeps the last content while closing, then unmounts once the close has played.
 */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  // A timer, not transitionend: that event never arrives when the transition is cancelled or skipped.
  const { mounted } = usePresence(open, 220);
  const last = useRef(children);
  if (open) last.current = children;
  if (!mounted) return null;
  return (
    <div className={`collapse ${open ? "open" : ""}`}>
      <div className="collapse-inner">{open ? children : last.current}</div>
    </div>
  );
}

function ReasoningStep({ p }: { p: ReasoningPart }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? !p.done;
  const heading = [...p.text.matchAll(/\*\*(.+?)\*\*/g)].at(-1)?.[1];
  return (
    <li className={`step ${p.done ? "" : "is-live"}`}>
      <button type="button" className="step-head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <span className="step-node"><Icon name="ring" size={14} /></span>
        <span className="step-verb">{p.done ? "考えた過程" : "考えています"}</span>
        {!p.done && heading && <span className="step-target">{heading}</span>}
        <span className={`step-caret ${isOpen ? "open" : ""}`}><Icon name="chevron" size={14} /></span>
      </button>
      <Collapse open={isOpen}>
        <div className="step-body reasoning">
          <Md text={p.text} />
        </div>
      </Collapse>
    </li>
  );
}

const TOOL_VIEW: Record<string, { icon: string; verb: string; key: string }> = {
  read_file: { icon: "file", verb: "読み込み", key: "path" },
  write_file: { icon: "file", verb: "書き込み", key: "path" },
  edit_file: { icon: "pencil", verb: "編集", key: "path" },
  bash: { icon: "terminal", verb: "コマンド", key: "command" },
  web_search: { icon: "search", verb: "ウェブ検索", key: "objective" },
};

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {before.split("\n").map((l, i) => <span key={`a${i}`} className="del">{l}{"\n"}</span>)}
      {after.split("\n").map((l, i) => <span key={`b${i}`} className="add">{l}{"\n"}</span>)}
    </pre>
  );
}

const pct = (v?: number) => (v === undefined ? "-" : `${Math.round(v * 100)}%`);
const judgeDetail = (j: Judge) => `読み取りのみ ${pct(j.readOnly)}、取り消せる操作 ${pct(j.reversible)}、依頼に沿う ${pct(j.servesTask)}`;

function SearchQueries({ args }: { args: Record<string, unknown> }) {
  const qs = Array.isArray(args.search_queries) ? args.search_queries.map(String) : [];
  return (
    <ul className="queries" aria-label="検索語">
      {qs.map((q) => <li key={q}>{q}</li>)}
    </ul>
  );
}

function ToolStep({ p }: { p: ToolPart }) {
  const [open, setOpen] = useState(false);
  const v = TOOL_VIEW[p.name] ?? { icon: "terminal", verb: p.name, key: "" };
  const a = parseArgs(p.args);
  const target = a[v.key] ?? "";
  const status: Record<ToolPart["status"], ReactNode> = {
    judging: <span className="badge judging"><span className="spin" />自動判定中</span>,
    running: <span className="spin" aria-label="実行中" />,
    awaiting: <span className="badge wait">承認待ち</span>,
    done: <span className="ok"><Icon name="check" size={14} /></span>,
    denied: <span className="badge muted">拒否しました</span>,
    error: <span className="badge bad">失敗</span>,
  };
  const body =
    p.name === "edit_file" ? <Diff before={a.old_str ?? ""} after={a.new_str ?? ""} /> :
    p.name === "write_file" ? <pre>{a.content}</pre> :
    p.name === "bash" ? <pre className="cmd">{`$ ${a.command ?? ""}`}</pre> :
    p.name === "web_search" ? <SearchQueries args={a} /> : null;

  return (
    <li className={`step tool-${p.status}`}>
      <button type="button" className="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-node"><Icon name={v.icon} size={14} /></span>
        <span className="step-verb">{v.verb}</span>
        <span className="step-target mono">{p.name === "bash" ? target.split("\n")[0] : target}</span>
        {p.judge?.ok && (
          <span className="badge auto" title={judgeDetail(p.judge)}>
            <Icon name="shield" size={12} />
            自動で許可
          </span>
        )}
        <span className="step-status">{status[p.status]}</span>
        <span className={`step-caret ${open ? "open" : ""}`}><Icon name="chevron" size={14} /></span>
      </button>
      <Collapse open={open}>
        <div className="step-body">
          {p.judge && p.status !== "awaiting" && (
            <p className="judge-line">
              <Icon name="shield" size={13} />
              {p.judge.ok ? "Jev の判定で自動的に許可しました。" : `自動では許可しませんでした。${p.judge.reason ?? ""}。`}
              {p.judge.by === "jev" && <span className="scores">{judgeDetail(p.judge)}</span>}
            </p>
          )}
          {body}
          {p.output !== undefined && (p.name === "web_search" && p.status === "done" ? (
            <div className="search-results"><Md text={p.output} /></div>
          ) : (
            <pre className={`out ${p.status === "error" ? "bad" : ""}`}>{p.output}</pre>
          ))}
        </div>
      </Collapse>
    </li>
  );
}

// ─── messages ─────────────────────────────────────────────────────────────

function ApproveCard({ p, onApprove }: { p: ToolPart; onApprove: (ok: boolean) => void }) {
  const command = parseArgs(p.args).command ?? "";
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
        <pre className="cmd">{`$ ${command}`}</pre>
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
 */
function StepChain({ parts, onApprove }: { parts: (ReasoningPart | ToolPart)[]; onApprove: (tool: string, ok: boolean) => void }) {
  const follow = useFollowBottom<HTMLDivElement>(parts, { tau: 1000 });
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = useCallback(() => {
    const el = follow.ref.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, [follow.ref]);
  useLayoutEffect(measure, [parts, measure]);

  return (
    <>
      <div
        ref={follow.ref}
        className={`steps-scroll ${edges.top ? "fade-top" : ""} ${edges.bottom ? "fade-bottom" : ""}`}
        onScroll={() => (follow.onScroll(), measure())}
        onWheel={follow.onUserScroll}
        onTouchStart={follow.onUserScroll}
      >
        <ol className="steps">
          {parts.map((p, i) =>
            p.type === "reasoning" ? <ReasoningStep key={i} p={p} /> : <ToolStep key={p.id} p={p} />,
          )}
        </ol>
      </div>
      {/* Outside the scroll area, so a pending approval is never scrolled out of view or faded at the edge. */}
      {parts.map((p) => p.type === "tool" && p.name === "bash" && <ApproveCard key={p.id} p={p} onApprove={(ok) => onApprove(p.id, ok)} />)}
    </>
  );
}

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
        <IconButton icon="pencil" label="編集して送り直す" size={16} disabled={busy} onClick={() => setEditing(true)} />
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

function AssistantBody({ m, fresh, models, isLast, busy, onApprove, onRegenerate }: {
  m: AssistantMessage; fresh: boolean; models: ServerState["models"]; isLast: boolean; busy: boolean;
  onApprove: (tool: string, ok: boolean) => void; onRegenerate: () => void;
}) {
  const bs = blocks(m.parts);
  const tail = m.parts.at(-1);
  const waiting =
    m.status === "streaming" &&
    (!tail || (tail.type === "reasoning" && tail.done) || (tail.type === "tool" && tail.status !== "running" && tail.status !== "awaiting"));
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  return (
    <div className={`msg assistant ${m.status === "streaming" ? "is-streaming" : ""} ${fresh ? "is-new" : ""}`}>
      {bs.map((b) =>
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
          {isLast && <IconButton icon="retry" label="回答を作り直す" size={16} disabled={busy} onClick={onRegenerate} />}
          <span className="model-tag">{models.find((x) => x.id === m.model)?.name ?? m.model}</span>
        </div>
      )}
    </div>
  );
}

function Thread({ conv, known, models, onApprove, onEdit, onRegenerate, onImage }: {
  conv: { meta: ConvMeta; messages: Message[] }; known: Set<string>; models: ServerState["models"];
  onApprove: (tool: string, ok: boolean) => void; onEdit: (from: UserMessage, text: string) => void;
  onRegenerate: () => void; onImage: (src: string) => void;
}) {
  const follow = useFollowBottom<HTMLDivElement>(conv, { near: 96, tau: 200, resetKey: conv.meta.id, observe: true });
  const busy = conv.meta.running;
  const lastAssistant = conv.messages.findLastIndex((m) => m.role === "assistant");

  return (
    <div className="thread" ref={follow.ref} onScroll={follow.onScroll} onWheel={follow.onUserScroll} onTouchStart={follow.onUserScroll}>
      <div className="column" key={conv.meta.id}>
        {conv.messages.map((m, i) =>
          m.role === "user" ? (
            <UserBubble key={m.id} m={m} fresh={!known.has(m.id)} busy={busy} onEdit={(t) => onEdit(m, t)} onImage={onImage} />
          ) : (
            <AssistantBody key={m.id} m={m} fresh={!known.has(m.id)} models={models} isLast={i === lastAssistant} busy={busy} onApprove={onApprove} onRegenerate={onRegenerate} />
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

// ─── composer ─────────────────────────────────────────────────────────────

function ModelPicker({ models, efforts, model, effort, jev, autoApprove, onModel, onEffort, onAutoApprove }: {
  models: ServerState["models"]; efforts: ServerState["efforts"]; model: string; effort: Effort; jev: boolean; autoApprove: boolean;
  onModel: (m: string) => void; onEffort: (e: Effort) => void; onAutoApprove: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const auto = jev && autoApprove;
  const pop = usePresence(open);
  // Open toward the side with more room, and scroll inside if even that is too short.
  const [place, setPlace] = useState<{ up: boolean; max: number }>({ up: true, max: 480 });
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // The empty screen scrolls, so it clips; elsewhere the viewport is the limit.
    const box = e.currentTarget.closest(".empty")?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    const above = r.top - box.top, below = box.bottom - r.bottom;
    setPlace({ up: above >= below, max: Math.max(above, below) - 16 });
    setOpen(!open);
  };
  return (
    <div className="picker" ref={ref}>
      <button type="button" className="picker-btn" onClick={toggle} aria-expanded={open} aria-haspopup="dialog">
        {auto && <span className="picker-auto" title="コマンドの自動承認が有効です"><Icon name="shield" size={14} /></span>}
        <span>{models.find((m) => m.id === model)?.name ?? model}</span>
        <span className="picker-effort">{efforts.find((e) => e.id === effort)?.name}</span>
        <Icon name="chevron" size={14} />
      </button>
      {pop.mounted && (
        <div className={`popover picker-pop ${place.up ? "up" : "down"} ${pop.leaving ? "leaving" : ""}`} style={{ maxHeight: place.max }} role="dialog" aria-label="モデルの選択">
          <div role="radiogroup" aria-label="モデル">
            {models.map((m) => (
              <button type="button" role="radio" aria-checked={m.id === model} key={m.id} className="pop-item" onClick={() => onModel(m.id)}>
                <span>{m.name}</span>
                {m.id === model && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
          <div className="pop-sep" />
          <p className="pop-label">考える深さ</p>
          <div className="segmented" role="radiogroup" aria-label="考える深さ">
            <span className="seg-thumb" aria-hidden="true" style={{ transform: `translateX(calc(${Math.max(0, efforts.findIndex((e) => e.id === effort))} * (100% + 2px)))` }} />
            {efforts.map((e) => (
              <button type="button" role="radio" aria-checked={e.id === effort} key={e.id} className={e.id === effort ? "on" : ""} onClick={() => onEffort(e.id)}>
                {e.name}
              </button>
            ))}
          </div>
          <div className="pop-sep" />
          <label className={`toggle-row ${jev ? "" : "is-off"}`}>
            <span className="toggle-text">
              <span>コマンドの自動承認</span>
              <span className="toggle-help">
                {jev ? "TypeSafe の Jev が安全と判定したコマンドは、確認せずに実行します" : "TYPESAFE_API_KEY を設定すると使えます"}
              </span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={auto} disabled={!jev} onChange={(e) => onAutoApprove(e.target.checked)} />
          </label>
        </div>
      )}
    </div>
  );
}

type ComposerHandle = { addFiles: (files: File[]) => void; focus: () => void };

const Composer = forwardRef<ComposerHandle, {
  value: string; onChange: (v: string) => void; running: boolean; disabled: boolean;
  onSend: (text: string, images: string[]) => Promise<boolean>; onStop: () => void; picker: ReactNode; placeholder: string;
}>(function Composer({ value, onChange, running, disabled, onSend, onStop, picker, placeholder }, handle) {
  const [images, setImages] = useState<string[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: File[]) => {
    const urls = await Promise.all(files.slice(0, 8).map(toDataUrl));
    setImages((cur) => [...cur, ...urls].slice(0, 8));
  }, []);
  useImperativeHandle(handle, () => ({ addFiles, focus: () => ta.current?.focus() }), [addFiles]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [value]);

  const canSend = !disabled && !running && (value.trim() !== "" || images.length > 0);
  const submit = async () => {
    if (!canSend) return;
    const [t, im] = [value, images];
    onChange("");
    setImages([]);
    if (!(await onSend(t, im))) (onChange(t), setImages(im));
  };

  return (
    <form
      className={`composer ${disabled ? "is-disabled" : ""}`}
      onSubmit={(e) => (e.preventDefault(), submit())}
      onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}
    >
      {images.length > 0 && (
        <div className="attachments">
          {images.map((src, i) => (
            <div className="attach" key={i}>
              <img src={src} alt="" />
              <button type="button" aria-label="画像を外す" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="メッセージ"
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          const files = imageFiles(e.clipboardData.files);
          if (files.length) (e.preventDefault(), addFiles(files));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
          if (e.key === "Escape" && running) onStop();
        }}
      />
      <div className="composer-bar">
        <IconButton icon="clip" label="画像を添付" disabled={disabled} onClick={() => fileInput.current?.click()} />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(imageFiles(e.target.files)), (e.target.value = ""))} />
        <div className="grow" />
        {picker}
        {running ? (
          <button type="button" key="stop" className="send stop" onClick={onStop} aria-label="生成を停止" title="生成を停止（Esc）">
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" key="send" className="send" disabled={!canSend} aria-label="送信" title="送信（Enter）">
            <Icon name="up" />
          </button>
        )}
      </div>
    </form>
  );
});

// ─── sidebar ──────────────────────────────────────────────────────────────

function ConvItem({ c, active, onOpen, onRename, onDelete }: {
  c: ConvMeta; active: boolean; onOpen: () => void; onRename: (t: string) => void; onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState(c.title);
  const close = useCallback(() => setMenu(false), []);
  const ref = useDismiss(menu, close);
  const pop = usePresence(menu);

  if (mode === "rename")
    return (
      <li className="conv editing" data-flip={c.id}>
        <input
          autoFocus
          value={title}
          aria-label="会話の名前"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => (setMode("view"), title.trim() && title !== c.title && onRename(title))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
            if (e.key === "Escape") (setTitle(c.title), setMode("view"));
          }}
        />
      </li>
    );
  if (mode === "delete")
    return (
      <li className="conv confirming" data-flip={c.id}>
        <span className="conv-title">「{c.title}」を削除しますか？</span>
        <div className="confirm-row">
          <button type="button" className="btn danger small" onClick={onDelete}>削除する</button>
          <button type="button" className="btn small" onClick={() => setMode("view")}>やめる</button>
        </div>
      </li>
    );
  return (
    <li className={`conv ${active ? "active" : ""}`} data-flip={c.id}>
      <a href={`/c/${c.id}`} onClick={(e) => (e.preventDefault(), onOpen())} aria-current={active ? "page" : undefined}>
        {c.running && <span className="live-dot" aria-label="応答を生成中" />}
        <span className="conv-title">{c.title}</span>
      </a>
      <div className="conv-menu" ref={ref}>
        <IconButton icon="dots" label="会話の操作" size={16} onClick={() => setMenu(!menu)} />
        {pop.mounted && (
          <div className={`popover menu-pop ${pop.leaving ? "leaving" : ""}`} role="menu">
            <button type="button" role="menuitem" className="pop-item" onClick={() => (setMenu(false), setTitle(c.title), setMode("rename"))}>
              <Icon name="pencil" size={15} />
              名前を変更
            </button>
            <button type="button" role="menuitem" className="pop-item danger" onClick={() => (setMenu(false), setMode("delete"))}>
              <Icon name="trash" size={15} />
              削除
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useStored<"system" | "light" | "dark">("shiro.theme", "system");
  const paint = (t: typeof theme) => {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  useEffect(() => paint(theme), [theme]);
  // The whole page crossfades between themes instead of every colour snapping at once.
  const choose = (t: typeof theme) => {
    const run = () => (paint(t), setTheme(t));
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(run);
    else run();
  };
  const opts = [
    { id: "system", icon: "monitor", label: "システムに合わせる" },
    { id: "light", icon: "sun", label: "明るいテーマ" },
    { id: "dark", icon: "moon", label: "暗いテーマ" },
  ] as const;
  return (
    <div className="theme-switch" role="radiogroup" aria-label="テーマ">
      <span className="seg-thumb" aria-hidden="true" style={{ transform: `translateX(${opts.findIndex((o) => o.id === theme) * 100}%)` }} />
      {opts.map((o) => (
        <button type="button" key={o.id} role="radio" aria-checked={theme === o.id} aria-label={o.label} title={o.label} className={theme === o.id ? "on" : ""} onClick={() => choose(o.id)}>
          <Icon name={o.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

function Sidebar({ convs, currentId, srv, query, setQuery, searchRef, onNew, onOpen, onRename, onDelete, onLogout, onClose }: {
  convs: ConvMeta[]; currentId: string | null; srv: ServerState | null; query: string; setQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onNew: () => void; onOpen: (id: string) => void; onRename: (id: string, t: string) => void; onDelete: (id: string) => void;
  onLogout: () => void; onClose: () => void;
}) {
  const shown = useMemo(() => convs.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())), [convs, query]);

  // FLIP: when a conversation jumps to the top (or the filter changes), each row slides from where it was.
  const listRef = useRef<HTMLElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const nav = listRef.current;
    if (!nav) return;
    const origin = nav.getBoundingClientRect().top - nav.scrollTop;
    const next = new Map<string, number>();
    const animate = tops.current.size > 0 && !reducedMotion();
    for (const el of nav.querySelectorAll<HTMLElement>("[data-flip]")) {
      const y = el.getBoundingClientRect().top - origin;
      const was = tops.current.get(el.dataset.flip!);
      next.set(el.dataset.flip!, y);
      if (!animate) continue;
      if (was === undefined)
        el.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: cssEase("--ease-out") });
      else if (Math.abs(was - y) > 1)
        el.animate([{ transform: `translateY(${was - y}px)` }, { transform: "none" }], { duration: 280, easing: cssEase("--ease-in-out") });
    }
    tops.current = next;
  }, [shown]);
  const groups: [string, ConvMeta[]][] = [];
  for (const c of shown) {
    const g = groupLabel(c.updatedAt);
    const last = groups.at(-1);
    if (last?.[0] === g) last[1].push(c);
    else groups.push([g, [c]]);
  }
  const account = srv?.account;
  return (
    <aside className="sidebar" aria-label="会話の一覧">
      <div className="side-top">
        <a className="wordmark" href="/" onClick={(e) => (e.preventDefault(), onNew())} aria-label="shiro 新しい会話">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.6 2.2" />
          </svg>
          <span>shiro</span>
        </a>
        <IconButton icon="panel" label="サイドバーを閉じる" onClick={onClose} />
      </div>
      <button type="button" className="new-chat" onClick={onNew}>
        <Icon name="compose" size={17} />
        新しい会話
        <kbd>Ctrl Shift O</kbd>
      </button>
      <label className="search">
        <Icon name="search" size={15} />
        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="会話を検索" aria-label="会話を検索" />
        {!query && <kbd>Ctrl K</kbd>}
      </label>
      <nav className="conv-list" ref={listRef}>
        {groups.map(([g, cs]) => (
          <section key={g}>
            <h2 data-flip={`group:${g}`}>{g}</h2>
            <ul>
              {cs.map((c) => (
                <ConvItem key={c.id} c={c} active={c.id === currentId} onOpen={() => onOpen(c.id)} onRename={(t) => onRename(c.id, t)} onDelete={() => onDelete(c.id)} />
              ))}
            </ul>
          </section>
        ))}
        {convs.length === 0 && <p className="side-empty">会話を始めると、ここに残ります。</p>}
        {convs.length > 0 && shown.length === 0 && <p className="side-empty">「{query}」に一致する会話はありません。</p>}
      </nav>
      <div className="side-foot">
        {srv && (
          <p className="cwd" title={srv.cwd}>
            <Icon name="folder" size={14} />
            <span>{srv.cwd.split("/").filter(Boolean).slice(-2).join("/")}</span>
          </p>
        )}
        <div className="foot-row">
          {account ? (
            <div className="account">
              <span className="avatar" aria-hidden="true">{(account.email ?? "?").slice(0, 1).toUpperCase()}</span>
              <span className="account-text">
                <span className="email">{account.email ?? "ChatGPT アカウント"}</span>
                {account.plan && <span className="plan">{account.plan}</span>}
              </span>
              <IconButton icon="logout" label="ログアウト" size={16} onClick={onLogout} />
            </div>
          ) : (
            <span className="account muted">未ログイン</span>
          )}
          <ThemeSwitch />
        </div>
      </div>
    </aside>
  );
}

// ─── app ──────────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "このリポジトリの構成を説明して",
  "未コミットの変更を確認して",
  "TODO コメントを探して一覧にして",
  "今日やることを整理したい",
];

function App() {
  const [srv, setSrv] = useState<ServerState | null>(null);
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(idFromPath);
  const [conv, setConv] = useState<{ meta: ConvMeta; messages: Message[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(true);
  const [sidebar, setSidebar] = useState(() => matchMedia("(min-width: 900px)").matches);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<{ msg: string; leaving: boolean } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const lightboxPresence = usePresence(!!lightbox, 200);
  const lightboxSrc = useRef<string | null>(null);
  if (lightbox) lightboxSrc.current = lightbox;
  const [dragging, setDragging] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [prefs, setPrefs] = useStored<{ model?: string; effort: Effort; autoApprove?: boolean }>("shiro.new", { effort: "medium" });

  const seq = useRef(0);
  const known = useRef<Set<string>>(new Set()); // messages present when the conversation was opened; only later ones animate in
  const buffer = useRef<Push[] | null>(null);
  const cur = useRef(currentId);
  const composer = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((msg: string) => {
    setToast({ msg, leaving: false });
    clearTimeout(toastTimer.current);
    // Leave the way it came in, then unmount once the 200ms exit transition has played.
    toastTimer.current = setTimeout(() => {
      setToast((t) => t && { ...t, leaving: true });
      toastTimer.current = setTimeout(() => setToast(null), 200);
    }, 4000);
  }, []);

  const navigate = useCallback((id: string | null) => {
    if (idFromPath() !== id) history.pushState(null, "", id ? `/c/${id}` : "/");
    cur.current = id;
    setCurrentId(id);
    if (!matchMedia("(min-width: 900px)").matches) setSidebar(false);
  }, []);

  const loadConv = useCallback(async (id: string) => {
    buffer.current = [];
    setLoading(true);
    try {
      const d = await api<{ meta: ConvMeta; messages: Message[]; seq: number }>(`/api/conversations/${id}`);
      if (cur.current !== id) return;
      let { messages, seq: s } = d;
      for (const p of buffer.current ?? []) if (p.type === "ev" && p.conv === id && p.seq > s) ((messages = apply(messages, p.ev)), (s = p.seq));
      seq.current = s;
      known.current = new Set(messages.map((m) => m.id));
      setConv({ meta: d.meta, messages });
    } catch (e) {
      if (cur.current === id) (say((e as Error).message), navigate(null));
    } finally {
      buffer.current = null;
      setLoading(false);
    }
  }, [navigate, say]);

  const refresh = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api<ServerState>("/api/state"), api<ConvMeta[]>("/api/conversations")]);
      setSrv(s);
      setConvs(list);
      if (cur.current) await loadConv(cur.current);
    } catch (e) {
      say((e as Error).message);
    }
  }, [loadConv, say]);

  // Push channel. A gap in sequence numbers means we missed events, so the conversation is reloaded.
  const onPush = useRef<(p: Push) => void>(() => {});
  onPush.current = (p) => {
    if (p.type === "ev") {
      if (p.conv !== cur.current) return;
      if (buffer.current) return void buffer.current.push(p);
      if (p.seq <= seq.current) return;
      if (p.seq !== seq.current + 1) return void loadConv(p.conv);
      seq.current = p.seq;
      setConv((c) => (c && c.meta.id === p.conv ? { ...c, messages: apply(c.messages, p.ev) } : c));
    } else if (p.type === "meta") {
      setConvs((cs) => [p.meta, ...cs.filter((c) => c.id !== p.meta.id)].sort((a, b) => b.updatedAt - a.updatedAt));
      setConv((c) => (c && c.meta.id === p.meta.id ? { ...c, meta: p.meta } : c));
    } else if (p.type === "deleted") {
      setConvs((cs) => cs.filter((c) => c.id !== p.id));
      if (cur.current === p.id) navigate(null);
    } else if (p.type === "auth") {
      setSrv((s) => (s ? { ...s, account: p.account } : s));
    }
  };

  useEffect(() => {
    let ws: WebSocket;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => {
        if (retry > 0) void refresh();
        retry = 0;
        setOnline(true);
      };
      ws.onclose = () => {
        if (stopped) return;
        setOnline(false);
        timer = setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
      };
      ws.onmessage = (m) => onPush.current(JSON.parse(m.data));
    };
    connect();
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws.close();
    };
  }, [refresh]);

  useEffect(() => {
    const f = () => ((cur.current = idFromPath()), setCurrentId(cur.current));
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, []);

  useEffect(() => {
    if (!currentId) return void setConv(null);
    if (conv?.meta.id === currentId) return;
    setConv(null);
    void loadConv(currentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  useEffect(() => {
    document.title = conv && conv.messages.length ? `${conv.meta.title} - shiro` : "shiro";
  }, [conv?.meta.title, conv?.messages.length]);

  const newChat = useCallback(() => {
    navigate(null);
    setTimeout(() => composer.current?.focus(), 0);
  }, [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") (e.preventDefault(), newChat());
      else if (mod && e.key.toLowerCase() === "k") (e.preventDefault(), setSidebar(true), setTimeout(() => searchRef.current?.focus(), 0));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [newChat]);

  const authed = !!srv?.account;
  const model = conv?.meta.model ?? prefs.model ?? srv?.defaultModel ?? "";
  const effort = conv?.meta.effort ?? prefs.effort;
  const autoApprove = conv?.meta.autoApprove ?? prefs.autoApprove ?? true;
  const running = !!conv?.meta.running;
  const draftKey = currentId ?? "new";

  const send = async (text: string, images: string[], from?: string) => {
    try {
      let id = currentId;
      if (!id) {
        const meta = await api<ConvMeta>("/api/conversations", { model, effort, autoApprove });
        seq.current = 0;
        known.current = new Set();
        setConv({ meta, messages: [] });
        navigate(meta.id);
        id = meta.id;
      }
      await api(`/api/conversations/${id}/messages`, { text, images, from });
      return true;
    } catch (e) {
      say((e as Error).message);
      return false;
    }
  };

  const patch = (body: object) => conv && api(`/api/conversations/${conv.meta.id}`, body, "PATCH").catch((e: Error) => say(e.message));

  const regenerate = () => {
    const lastUser = conv?.messages.findLast((m): m is UserMessage => m.role === "user");
    if (lastUser) void send(lastUser.text, lastUser.images, lastUser.id);
  };

  const login = async () => {
    try {
      const { url } = await api<{ url: string }>("/api/login", {});
      location.href = url;
    } catch (e) {
      say((e as Error).message);
    }
  };

  const picker = srv && (
    <ModelPicker
      models={srv.models}
      efforts={srv.efforts}
      model={model}
      effort={effort}
      onModel={(m) => (conv ? patch({ model: m }) : setPrefs({ ...prefs, model: m }))}
      jev={srv.jev}
      autoApprove={autoApprove}
      onEffort={(e) => (conv ? patch({ effort: e }) : setPrefs({ ...prefs, effort: e }))}
      onAutoApprove={(v) => (conv ? patch({ autoApprove: v }) : setPrefs({ ...prefs, autoApprove: v }))}
    />
  );

  const composerEl = (
    <Composer
      ref={composer}
      value={drafts[draftKey] ?? ""}
      onChange={(v) => setDrafts((d) => ({ ...d, [draftKey]: v }))}
      running={running}
      disabled={!authed}
      onSend={(t, im) => send(t, im)}
      onStop={() => conv && api(`/api/conversations/${conv.meta.id}/stop`, {}).catch((e: Error) => say(e.message))}
      picker={picker}
      placeholder={running ? "応答の生成中です" : "shiro にメッセージを送る"}
    />
  );

  const showThread = !!conv && conv.messages.length > 0;

  return (
    <div
      className={`app ${sidebar ? "side-open" : ""}`}
      onDragOver={(e) => {
        if (authed && [...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) (e.preventDefault(), setDragging(true));
      }}
      onDragLeave={(e) => e.relatedTarget === null && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        composer.current?.addFiles(imageFiles(e.dataTransfer.files));
      }}
    >
      <Sidebar
        convs={convs}
        currentId={currentId}
        srv={srv}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        onNew={newChat}
        onOpen={navigate}
        onRename={(id, title) => api(`/api/conversations/${id}`, { title }, "PATCH").catch((e: Error) => say(e.message))}
        onDelete={(id) => api(`/api/conversations/${id}`, undefined, "DELETE").catch((e: Error) => say(e.message))}
        onLogout={() => api("/api/logout", {}).catch((e: Error) => say(e.message))}
        onClose={() => setSidebar(false)}
      />
      <div className="scrim" onClick={() => setSidebar(false)} aria-hidden="true" />

      <main className="main">
        <header className="topbar">
          {!sidebar && <IconButton icon="panel" label="サイドバーを開く" onClick={() => setSidebar(true)} />}
          {!sidebar && <IconButton icon="compose" label="新しい会話" onClick={newChat} />}
          <h1 className="top-title" key={showThread ? conv.meta.id : "none"}>{showThread ? conv.meta.title : ""}</h1>
          {!online && <span className="offline" role="status">サーバーとの接続が切れています。再接続しています</span>}
        </header>

        {showThread ? (
          <>
            <Thread
              conv={conv}
              known={known.current}
              models={srv?.models ?? []}
              onApprove={(tool, ok) => api(`/api/conversations/${conv.meta.id}/approve`, { tool, ok }).catch((e: Error) => say(e.message))}
              onEdit={(m, t) => void send(t, m.images, m.id)}
              onRegenerate={regenerate}
              onImage={setLightbox}
            />
            <div className="dock">
              {composerEl}
              <p className="disclaimer">
                shiro はこのマシン上でファイルを読み書きします。
                {srv?.jev && autoApprove ? "Jev が安全と判定したコマンドは確認せずに実行し、それ以外は実行前に確認します。" : "コマンドは実行前に確認します。"}
              </p>
            </div>
          </>
        ) : loading || (currentId && !conv) ? (
          <div className="center"><span className="spin large" aria-label="読み込み中" /></div>
        ) : (
          <div className="empty">
            <Ring />
            {srv && !authed ? (
              <div className="login">
                <h2 className="greeting">はじめに、ChatGPT のアカウントでログインしてください</h2>
                <p>shiro は ChatGPT のプランに含まれる Codex の利用枠で応答します。</p>
                <button type="button" className="btn primary large" onClick={login}>ChatGPT でログイン</button>
              </div>
            ) : (
              <>
                <h2 className="greeting">何から始めますか</h2>
                <div className="empty-composer">{composerEl}</div>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      type="button"
                      key={s}
                      className="chip"
                      onClick={() => (setDrafts((d) => ({ ...d, new: s })), composer.current?.focus())}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {dragging && (
        <div className="drop" aria-hidden="true">
          <p>画像をここにドロップして添付</p>
        </div>
      )}
      {lightboxPresence.mounted && (
        <div className={`lightbox ${lightboxPresence.leaving ? "leaving" : ""}`} role="dialog" aria-label="画像" onClick={() => setLightbox(null)} onKeyDown={(e) => e.key === "Escape" && setLightbox(null)} tabIndex={-1} ref={(el) => el?.focus()}>
          <img src={lightboxSrc.current ?? ""} alt="" />
          <IconButton icon="x" label="閉じる" className="lightbox-close" onClick={() => setLightbox(null)} />
        </div>
      )}
      {toast && (
        <div className={`toast ${toast.leaving ? "leaving" : ""}`} role="status">
          <Icon name="alert" size={16} />
          {toast.msg}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
