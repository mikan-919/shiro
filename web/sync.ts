// The browser half of the server protocol: REST calls, and the WebSocket event stream kept in step with
// the conversation on screen.
import { useCallback, useEffect, useRef, useState } from "react";
import { apply, type Board, type Account, type ConvView, type Message, type Push, type Settings } from "../shared";
export type { Settings };

export type ServerState = { account: Account | null; cwd: string; defaultModel: string; jev: boolean };
export type Conversation = { meta: ConvView; messages: Message[]; board?: Board };

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `サーバーがエラーを返しました（${r.status}）`);
  return j as T;
}

/** State kept in localStorage; unavailable storage (private mode, blocked) just means no memory. */
export function useStored<T>(key: string, init: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? init : (JSON.parse(s) as T);
    } catch {
      return init;
    }
  });
  const set = useCallback(
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(key, JSON.stringify(n));
      } catch {}
    },
    [key],
  );
  return [v, set] as const;
}

const contextFromPath = () => /^\/c\/[\w-]+\/context\/?$/.test(location.pathname);
const idFromPath = () => /^\/c\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;

/**
 * The server's state and the open conversation, kept current from the event stream. Each conversation's
 * events carry consecutive sequence numbers: events that arrive while the conversation loads are held and
 * replayed, and a gap means some were missed, so the conversation is loaded again.
 */
export function useLive(say: (msg: string) => void) {
  const [srv, setSrv] = useState<ServerState | null>(null);
  const [convs, setConvs] = useState<ConvView[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(idFromPath);
  const [contextPage, setContextPage] = useState(contextFromPath);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [online, setOnline] = useState(true);
  /** Bumped when the colony may have changed; the shared-context page reloads it. */
  const [colonyRev, setColonyRev] = useState(0);
  const seq = useRef(0);
  const held = useRef<Push[] | null>(null);
  const cur = useRef(currentId);
  /** Messages present when the conversation was opened. Only later ones animate in. */
  const known = useRef<Set<string>>(new Set());
  const fail = useCallback((e: unknown) => say((e as Error).message), [say]);

  // Points the URL and the screen at a conversation. The shown one stays while it is the same, so reloading it does not flash.
  const show = useCallback((id: string | null, context = false) => {
    const path = id ? `/c/${id}${context ? "/context" : ""}` : "/";
    if (location.pathname !== path) history.pushState(null, "", path);
    setContextPage(context && !!id);
    cur.current = id;
    setCurrentId(id);
    setConv((c) => (id && c?.meta.id === id ? c : null));
  }, []);

  const load = useCallback(async function loadConversation(id: string) {
    const pending: Push[] = [];
    held.current = pending;
    try {
      const d = await api<Conversation & { seq: number }>(`/api/conversations/${id}`);
      if (cur.current !== id || held.current !== pending) return;
      let { meta, messages, board, seq: s } = d;
      for (const p of pending) {
        if (p.type === "meta" && p.meta.id === id && p.meta.updatedAt >= meta.updatedAt) meta = p.meta;
        if (p.type !== "ev" || p.conv !== id || p.seq <= s) continue;
        if (p.seq !== s + 1) return void loadConversation(id);
        messages = apply(messages, p.ev);
        if (p.ev.t === "board") board = p.ev.board;
        s = p.seq;
      }
      seq.current = s;
      known.current = new Set(messages.map((m) => m.id));
      setConv({ meta, messages, board });
    } catch (e) {
      if (cur.current === id && held.current === pending) (fail(e), show(null));
    } finally {
      if (held.current === pending) held.current = null;
    }
  }, [fail, show]);

  /** Shows a conversation (null: the new-chat screen). Pass `initial` when its contents are already known. */
  const open = useCallback((id: string | null, initial?: Conversation, context = false) => {
    show(id, context);
    if (!id) return;
    if (initial) {
      seq.current = 0;
      known.current = new Set();
      return setConv(initial);
    }
    void load(id);
  }, [show, load]);

  const refresh = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api<ServerState>("/api/state"), api<ConvView[]>("/api/conversations")]);
      setSrv(s);
      setConvs(list);
      setColonyRev((n) => n + 1);
      if (cur.current) await load(cur.current);
    } catch (e) {
      fail(e);
    }
  }, [load, fail]);

  const onPush = useRef<(p: Push) => void>(() => {});
  onPush.current = (p) => {
    if (p.type === "ev") {
      if (p.conv !== cur.current) return;
      if (held.current) return void held.current.push(p);
      if (p.seq <= seq.current) return;
      if (p.seq !== seq.current + 1) return void load(p.conv);
      seq.current = p.seq;
      setConv((c) => (c && c.meta.id === p.conv ? { ...c, messages: apply(c.messages, p.ev), board: p.ev.t === "board" ? p.ev.board : c.board } : c));
    } else if (p.type === "meta") {
      if (held.current && p.meta.id === cur.current) held.current.push(p);
      setConvs((cs) => [p.meta, ...cs.filter((c) => c.id !== p.meta.id)].sort((a, b) => b.updatedAt - a.updatedAt));
      setConv((c) => (c && c.meta.id === p.meta.id ? { ...c, meta: p.meta } : c));
    } else if (p.type === "deleted") {
      setConvs((cs) => cs.filter((c) => c.id !== p.id));
      if (cur.current === p.id) show(null);
    } else if (p.type === "auth") {
      setSrv((s) => (s ? { ...s, account: p.account } : s));
      if (p.error) say(p.error);
    } else if (p.type === "colony") setColonyRev((n) => n + 1);
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
    const f = () => open(idFromPath(), undefined, contextFromPath());
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, [open]);

  const call = <T,>(p: Promise<T>) => p.catch(fail);
  const id = conv?.meta.id;

  return {
    srv,
    convs,
    currentId,
    conv,
    online,
    contextPage,
    colonyRev,
    openContext: () => { if (currentId) open(currentId, undefined, true); },
    known: known.current,
    open,

    async send(text: string, images: string[], settings: Settings, from?: string) {
      try {
        let target = currentId;
        if (!target) {
          const meta = await api<ConvView>("/api/conversations", settings);
          open(meta.id, { meta, messages: [] });
          target = meta.id;
        }
        await api(`/api/conversations/${target}/messages`, { text, images, from });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    update: (body: Partial<Settings>) => id && call(api(`/api/conversations/${id}`, body, "PATCH")),
    stop: () => id && call(api(`/api/conversations/${id}/stop`, {})),
    approve: (callId: string, ok: boolean) => id && call(api(`/api/conversations/${id}/approve`, { call: callId, ok })),
    react: (bubble: string, emoji: string | null) => id && call(api(`/api/conversations/${id}/react`, { target: bubble, emoji })),
    rename: (cid: string, title: string) => call(api(`/api/conversations/${cid}`, { title }, "PATCH")),
    remove: (cid: string) => call(api(`/api/conversations/${cid}`, undefined, "DELETE")),
    logout: () => call(api("/api/logout", {})),
    async login() {
      try {
        location.href = (await api<{ url: string }>("/api/login", {})).url;
      } catch (e) {
        fail(e);
      }
    },
  };
}
