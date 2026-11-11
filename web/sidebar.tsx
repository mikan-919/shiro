import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConvView } from "../shared";
import { useStored, type ServerState } from "./sync";
import { Icon, IconButton, usePopover } from "./ui";
import { cssEase, reducedMotion } from "./motion";
import "./sidebar.css";

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

function ConvItem({ c, active, onOpen, onRename, onDelete }: {
  c: ConvView; active: boolean; onOpen: () => void; onRename: (t: string) => void; onDelete: () => void;
}) {
  const menu = usePopover();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState(c.title);

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
      <div className="conv-menu" ref={menu.ref}>
        <IconButton icon="dots" label="会話の操作" small onClick={() => menu.setOpen(!menu.open)} />
        {menu.mounted && (
          <div className={`popover menu-pop ${menu.leaving ? "leaving" : ""}`} style={menu.style} role="menu">
            <button type="button" role="menuitem" className="pop-item" onClick={() => (menu.setOpen(false), setTitle(c.title), setMode("rename"))}>
              <Icon name="pencil" size={15} />
              名前を変更
            </button>
            <button type="button" role="menuitem" className="pop-item danger" onClick={() => (menu.setOpen(false), setMode("delete"))}>
              <Icon name="trash" size={15} />
              削除
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

const THEMES = [
  { id: "system", icon: "monitor", label: "システムに合わせる" },
  { id: "light", icon: "sun", label: "明るいテーマ" },
  { id: "dark", icon: "moon", label: "暗いテーマ" },
] as const;

function ThemeSwitch() {
  // The same key is read by the inline script in index.html, which paints the theme before React loads.
  const [theme, setTheme] = useStored<(typeof THEMES)[number]["id"]>("shiro.theme", "system");
  const choose = (t: typeof theme) => {
    const run = () => {
      if (t === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
      setTheme(t);
    };
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(run);
    else run();
  };
  return (
    <div className="theme-switch seg" role="radiogroup" aria-label="テーマ" style={{ "--n": THEMES.length, "--i": THEMES.findIndex((o) => o.id === theme) } as React.CSSProperties}>
      <span className="seg-thumb" aria-hidden="true" />
      {THEMES.map((o) => (
        <button type="button" key={o.id} role="radio" aria-checked={theme === o.id} aria-label={o.label} title={o.label} className={theme === o.id ? "on" : ""} onClick={() => choose(o.id)}>
          <Icon name={o.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

/** FLIP: when the list changes (a conversation jumps to the top, a filter), each row slides from where it was. */
function useFlip(list: unknown) {
  const ref = useRef<HTMLElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const nav = ref.current;
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
  }, [list]);
  return ref;
}

export function Sidebar({ convs, currentId, srv, query, setQuery, searchRef, onNew, onOpen, onRename, onDelete, onLogout, onClose }: {
  convs: ConvView[]; currentId: string | null; srv: ServerState | null; query: string; setQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onNew: () => void; onOpen: (id: string) => void; onRename: (id: string, t: string) => void; onDelete: (id: string) => void;
  onLogout: () => void; onClose: () => void;
}) {
  const shown = useMemo(() => convs.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())), [convs, query]);
  const listRef = useFlip(shown);
  const groups: [string, ConvView[]][] = [];
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
          <Icon name="ring" size={22} />
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
              <IconButton icon="logout" label="ログアウト" small onClick={onLogout} />
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
