import "./base.css";
import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DEFAULTS, type UserMessage } from "../shared";
import { useLive, useStored, type Settings } from "./sync";
import { Icon, IconButton } from "./ui";
import { LoaderCircle } from "lucide-react";
import { cssEase, reducedMotion, useLinger } from "./motion";
import { Composer, SettingsPicker, imageFiles, type ComposerHandle } from "./composer";
import { ContextPage } from "./context";
import { Thread } from "./thread";
import { Sidebar } from "./sidebar";
import { Empty } from "./empty";
import "./app.css";

// The same 900px breakpoint switches the sidebar between drawer and column in sidebar.css.
const wide = () => matchMedia("(min-width: 900px)").matches;
/** How long the lightbox takes to close: its image's flight back and its backdrop's fade. */
const ZOOM_OUT = 220;

/**
 * The enlarged image grows out of the thumbnail that was clicked and shrinks back into it; closing mid-flight
 * carries on from where the image is. With no thumbnail in view it only settles into place, and with reduced
 * motion nothing moves: the backdrop's fade (app.css) is all there is.
 */
function Lightbox({ src, from, leaving, style, onClose }: { src: string; from: HTMLElement | null; leaving: boolean; style: CSSProperties; onClose: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const el = img.current;
    if (!el || reducedMotion()) return;
    const fly = () => {
      const now = getComputedStyle(el).transform;
      for (const a of el.getAnimations()) a.cancel();
      const a = from?.getBoundingClientRect(), b = el.getBoundingClientRect();
      const s = a && b.width ? a.width / b.width : 0;
      const small = a && s > 0 && a.bottom > 0 && a.top < innerHeight
        ? { transform: `translate(${a.left + a.width / 2 - b.left - b.width / 2}px, ${a.top + a.height / 2 - b.top - b.height / 2}px) scale(${s})`, borderRadius: `${parseFloat(getComputedStyle(from!).borderRadius) / s}px` }
        : { transform: "scale(0.96)" };
      // Leaving is quicker than arriving.
      el.animate(leaving ? [{ transform: now }, small] : [small, { transform: "none" }], { duration: leaving ? ZOOM_OUT : 300, easing: cssEase("--ease-drawer"), fill: "both" });
    };
    if (el.complete) fly();
    else el.addEventListener("load", fly, { once: true });
  }, [leaving, from]);
  return (
    <div className={`lightbox ${leaving ? "leaving" : ""}`} style={style} role="dialog" aria-label="画像" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()} tabIndex={-1} ref={(el) => el?.focus()}>
      <img ref={img} src={src} alt="" />
      <IconButton icon="x" label="閉じる" className="lightbox-close" onClick={onClose} />
    </div>
  );
}

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
  const lightbox = useLinger(lightboxSrc, ZOOM_OUT);
  const lightboxFrom = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const drop = useLinger(dragging || null, 150);
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
            <span className={`who-avatar ${running ? "is-live" : ""}`} aria-hidden="true">
              <Icon name="ring" size={26} />
            </span>
            <span className="who-name">shiro</span>
            {showThread && <span className="who-title" key={conv.meta.title}>{conv.meta.title}</span>}
          </h1>
          <div className="top-actions">
            {!live.contextPage && srv && <SettingsPicker settings={settings} jev={srv.jev} auto={autoApproving} full={settings.fullAccess} onChange={updateSettings} />}
            {live.currentId && <button type="button" className="btn small" aria-pressed={live.contextPage} onClick={() => live.contextPage ? live.open(live.currentId) : live.openContext()}>{live.contextPage ? "チャット" : "共有文脈"}</button>}
            <IconButton icon="compose" label="新しい会話" onClick={newChat} />
          </div>
        </header>
        {!live.online && <p className="offline" role="status">サーバーとの接続が切れています。再接続しています</p>}

        {live.contextPage && conv ? (
          <ContextPage board={conv.board} running={conv.meta.running} title={conv.meta.title} id={conv.meta.id} colonyRev={live.colonyRev} />
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
              onImage={(src, from) => ((lightboxFrom.current = from), setLightbox(src))}
            />
          </>
        ) : live.currentId && !conv ? (
          <div className="center"><LoaderCircle className="spin large" strokeWidth={1.7} role="img" aria-label="読み込み中" /></div>
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

      {drop.value && (
        <div className={`drop ${drop.leaving ? "leaving" : ""}`} aria-hidden="true">
          <p>画像をここにドロップして添付</p>
        </div>
      )}
      {lightbox.value && <Lightbox src={lightbox.value} from={lightboxFrom.current} leaving={lightbox.leaving} style={lightbox.style} onClose={() => setLightbox(null)} />}
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
