import "./base.css";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DEFAULTS, type UserMessage } from "../shared";
import { useLive, useStored, type Settings } from "./sync";
import { Icon, IconButton } from "./ui";
import { useLinger } from "./motion";
import { Composer, SettingsPicker, imageFiles, type ComposerHandle } from "./composer";
import { ContextPage } from "./context";
import { Thread } from "./thread";
import { Sidebar } from "./sidebar";
import { Empty } from "./empty";
import "./app.css";

// The same 900px breakpoint switches the sidebar between drawer and column in sidebar.css.
const wide = () => matchMedia("(min-width: 900px)").matches;

function App() {
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toast = useLinger(toastMsg, 200);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const live = useLive(say);
  const { srv, conv } = live;
  const [sidebar, setSidebar] = useState(wide);
  const [query, setQuery] = useState("");
  const [lightboxSrc, setLightbox] = useState<string | null>(null);
  const lightbox = useLinger(lightboxSrc, 200);
  const [dragging, setDragging] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Settings for the next new conversation; an open conversation keeps its own. */
  const [prefs, setPrefs] = useStored<Partial<Settings>>("shiro.new", {});
  const composer = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const settings: Settings = conv?.meta ?? { model: srv?.defaultModel ?? "", ...DEFAULTS, ...prefs };
  const updateSettings = (patch: Partial<Settings>) => (conv ? live.update(patch) : setPrefs({ ...prefs, ...patch }));
  const autoApproving = !!srv?.jev && settings.autoApprove;
  const authed = !!srv?.account;
  const running = !!conv?.meta.running;
  const draftKey = live.currentId ?? "new";

  const open = (id: string | null) => {
    live.open(id);
    if (!wide()) setSidebar(false);
  };
  const newChat = () => {
    flushSync(() => open(null));
    composer.current?.focus();
  };
  const send = (text: string, images: string[], from?: string) => live.send(text, images, settings, from);
  const regenerate = () => {
    const u = conv?.messages.findLast((m): m is UserMessage => m.role === "user");
    if (u) void send(u.text, u.images, u.id);
  };

  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcuts.current = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      newChat();
    } else if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      flushSync(() => setSidebar(true));
      searchRef.current?.focus();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => shortcuts.current(e);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.title = conv && conv.messages.length ? `${conv.meta.title} - shiro` : "shiro";
  }, [conv?.meta.title, conv?.messages.length]);

  const composerEl = (
    <Composer
      ref={composer}
      value={drafts[draftKey] ?? ""}
      onChange={(v) => setDrafts((d) => ({ ...d, [draftKey]: v }))}
      running={running}
      disabled={!authed}
      onSend={(t, im) => send(t, im)}
      onStop={live.stop}
      placeholder={running ? "実行中でもメッセージを送れます" : "shiro にメッセージを送る"}
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
        convs={live.convs}
        currentId={live.currentId}
        srv={srv}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        onNew={newChat}
        onOpen={open}
        onRename={live.rename}
        onDelete={live.remove}
        onLogout={live.logout}
        onClose={() => setSidebar(false)}
      />
      <div className="scrim" onClick={() => setSidebar(false)} aria-hidden="true" />

      <main className="main">
        <header className="topbar">
          <IconButton icon="menu" label={sidebar ? "会話の一覧を閉じる" : "会話の一覧を開く"} onClick={() => setSidebar(!sidebar)} />
          <h1 className="who">
            <span className="who-avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26">
                <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.6 2.2" />
              </svg>
            </span>
            <span className="who-name">shiro</span>
            {showThread && <span className="who-title" key={conv.meta.id}>{conv.meta.title}</span>}
          </h1>
          <div className="top-actions">
            {!live.contextPage && srv && <SettingsPicker settings={settings} jev={srv.jev} auto={autoApproving} onChange={updateSettings} />}
            {live.currentId && <button type="button" className="btn small" aria-pressed={live.contextPage} onClick={() => live.contextPage ? live.open(live.currentId) : live.openContext()}>{live.contextPage ? "チャット" : "共有文脈"}</button>}
            <IconButton icon="compose" label="新しい会話" onClick={newChat} />
          </div>
        </header>
        {!live.online && <p className="offline" role="status">サーバーとの接続が切れています。再接続しています</p>}

        {live.contextPage && conv ? (
          <ContextPage board={conv.board} running={conv.meta.running} title={conv.meta.title} />
        ) : showThread ? (
          <>
            <Thread
              key={conv.meta.id}
              conv={conv}
              known={live.known}
              onApprove={live.approve}
              onReact={live.react}
              onEdit={(m, t) => void send(t, m.images, m.id)}
              onRegenerate={regenerate}
              onImage={setLightbox}
            />
          </>
        ) : live.currentId && !conv ? (
          <div className="center"><span className="spin large" aria-label="読み込み中" /></div>
        ) : (
          <Empty
            needsLogin={!!srv && !authed}
            onLogin={live.login}
            onSuggest={(s) => {
              setDrafts((d) => ({ ...d, [draftKey]: s }));
              composer.current?.focus();
            }}
          />
        )}
        {!live.contextPage && <div className="dock">{composerEl}</div>}
      </main>

      {dragging && (
        <div className="drop" aria-hidden="true">
          <p>画像をここにドロップして添付</p>
        </div>
      )}
      {lightbox.value && (
        <div className={`lightbox ${lightbox.leaving ? "leaving" : ""}`} style={lightbox.style} role="dialog" aria-label="画像" onClick={() => setLightbox(null)} onKeyDown={(e) => e.key === "Escape" && setLightbox(null)} tabIndex={-1} ref={(el) => el?.focus()}>
          <img src={lightbox.value} alt="" />
          <IconButton icon="x" label="閉じる" className="lightbox-close" onClick={() => setLightbox(null)} />
        </div>
      )}
      {toast.value && (
        <div className={`toast ${toast.leaving ? "leaving" : ""}`} style={toast.style} role="status">
          <Icon name="alert" size={16} />
          {toast.value}
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
