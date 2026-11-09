import "./base.css";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DEFAULTS, type UserMessage } from "../shared";
import { useLive, useStored, type Settings } from "./sync";
import { Icon, IconButton } from "./ui";
import { useLinger } from "./motion";
import { Composer, SettingsPicker, imageFiles, type ComposerHandle } from "./composer";
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
      picker={srv && <SettingsPicker settings={settings} jev={srv.jev} onChange={updateSettings} />}
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
          {!sidebar && (
            <>
              <IconButton icon="panel" label="サイドバーを開く" onClick={() => setSidebar(true)} />
              <IconButton icon="compose" label="新しい会話" onClick={newChat} />
            </>
          )}
          <h1 className="top-title" key={showThread ? conv.meta.id : "none"}>{showThread ? conv.meta.title : ""}</h1>
          {!live.online && <span className="offline" role="status">サーバーとの接続が切れています。再接続しています</span>}
        </header>

        {showThread ? (
          <>
            <Thread
              key={conv.meta.id}
              conv={conv}
              known={live.known}
              onApprove={live.approve}
              onEdit={(m, t) => void send(t, m.images, m.id)}
              onRegenerate={regenerate}
              onImage={setLightbox}
            />
            <div className="dock">
              {composerEl}
              <p className="disclaimer">
                shiro はこのマシン上でファイルを読み書きします。
                {autoApproving ? "Jev が安全と判定したコマンドは確認せずに実行し、それ以外は実行前に確認します。" : "コマンドは実行前に確認します。"}
              </p>
            </div>
          </>
        ) : live.currentId && !conv ? (
          <div className="center"><span className="spin large" aria-label="読み込み中" /></div>
        ) : (
          <Empty
            needsLogin={!!srv && !authed}
            composer={composerEl}
            onLogin={live.login}
            onSuggest={(s) => {
              setDrafts((d) => ({ ...d, new: s }));
              composer.current?.focus();
            }}
          />
        )}
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
