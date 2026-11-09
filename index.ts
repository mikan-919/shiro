import OpenAI from "openai";
import type { ResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import { account, getCred, hasCred, logout, startLogin } from "./auth";
import page from "./web/index.html";
import { TOOLS, runTool } from "./tools";
import * as store from "./store";
import { apply, assistantText, EFFORTS, MODELS, type ConvMeta, type Effort, type Ev, type Push } from "./shared";

const PORT = Number(process.env.SHIRO_PORT ?? 3000);
const DEFAULT_MODEL = process.env.SHIRO_MODEL ?? MODELS[0].id;
const CWD = process.cwd();
const instructions = `You are shiro, a coding and everyday agent running on the user's own machine in ${CWD}.
Use the tools to inspect and change files and run commands. Reply in the user's language. Use Markdown. Be concise.`;

type Running = { ctl: AbortController; approvals: Map<string, (ok: boolean) => void> };
const running = new Map<string, Running>();
const seqs = new Map<string, number>();
let login: ReturnType<typeof startLogin> | null = null;

const publish = (p: Push) => server.publish("ui", JSON.stringify(p));
const metaOf = (c: store.Conv): ConvMeta => ({ ...c.meta, running: running.has(c.meta.id) });

function emit(c: store.Conv, ev: Ev) {
  c.messages = apply(c.messages, ev);
  const seq = (seqs.get(c.meta.id) ?? 0) + 1;
  seqs.set(c.meta.id, seq);
  publish({ type: "ev", conv: c.meta.id, seq, ev });
}

function touch(c: store.Conv) {
  c.meta.updatedAt = Date.now();
  store.save(c);
  publish({ type: "meta", meta: metaOf(c) });
}

function userItem(text: string, images: string[]): ResponseInputItem {
  if (!images.length) return { role: "user", content: text };
  return {
    role: "user",
    content: [{ type: "input_text", text }, ...images.map((image_url) => ({ type: "input_image" as const, image_url, detail: "auto" as const }))],
  };
}

async function runTurn(c: store.Conv, text: string, images: string[]) {
  const r: Running = { ctl: new AbortController(), approvals: new Map() };
  running.set(c.meta.id, r);
  // Stopping while a command waits for approval counts as a denial; the next request then sees the abort.
  r.ctl.signal.addEventListener("abort", () => r.approvals.forEach((resolve) => resolve(false)));
  const itemIndex = c.items.length;
  if (!c.messages.length) c.meta.title = text.replace(/\s+/g, " ").trim().slice(0, 40) || "画像";
  emit(c, { t: "user", msg: { id: crypto.randomUUID(), role: "user", text, images, itemIndex } });
  c.items.push(userItem(text, images));
  emit(c, { t: "assistant", id: crypto.randomUUID(), model: c.meta.model });
  touch(c);

  const confirm = (id: string) => () =>
    new Promise<boolean>((resolve) => {
      r.approvals.set(id, resolve);
      emit(c, { t: "tool_status", id, status: "awaiting" });
    }).then((ok) => {
      r.approvals.delete(id);
      emit(c, { t: "tool_status", id, status: ok ? "running" : "denied" });
      return ok;
    });

  try {
    while (true) {
      const { access, accountId } = await getCred();
      const client = new OpenAI({
        apiKey: access,
        baseURL: process.env.SHIRO_CODEX_URL ?? "https://chatgpt.com/backend-api/codex",
        defaultHeaders: { "chatgpt-account-id": accountId, "OpenAI-Beta": "responses=experimental", originator: "shiro", "session-id": c.meta.id },
      });
      const stream = await client.responses.create(
        {
          model: c.meta.model, instructions, input: c.items, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: true,
          reasoning: { effort: c.meta.effort, summary: "auto" },
          store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: c.meta.id,
        },
        { signal: r.ctl.signal },
      );
      const calls: ResponseFunctionToolCall[] = [];
      for await (const ev of stream) {
        if (ev.type === "response.reasoning_summary_text.delta") emit(c, { t: "reasoning_delta", text: ev.delta });
        else if (ev.type === "response.reasoning_summary_part.done") emit(c, { t: "reasoning_delta", text: "\n\n" });
        else if (ev.type === "response.output_text.delta") emit(c, { t: "text_delta", text: ev.delta });
        else if (ev.type === "response.output_item.done") {
          if (ev.item.type === "reasoning") emit(c, { t: "reasoning_end" });
          c.items.push(ev.item as ResponseInputItem);
          if (ev.item.type === "function_call") calls.push(ev.item);
        } else if (ev.type === "response.failed") throw new Error(ev.response.error?.message ?? "応答の生成に失敗しました");
      }
      if (!calls.length) break;

      for (const call of calls) {
        emit(c, { t: "tool", id: call.call_id, name: call.name, args: call.arguments });
        let output: string;
        try {
          output = await runTool(call.name, JSON.parse(call.arguments), confirm(call.call_id), r.ctl.signal);
          if (output !== "user denied this command") emit(c, { t: "tool_status", id: call.call_id, status: "done", output });
        } catch (e) {
          if (r.ctl.signal.aborted) throw e;
          output = `error: ${(e as Error).message}`;
          emit(c, { t: "tool_status", id: call.call_id, status: "error", output });
        }
        c.items.push({ type: "function_call_output", call_id: call.call_id, output });
      }
    }
    emit(c, { t: "end", status: "done" });
  } catch (e) {
    // Drop half-finished tool calls so the history stays valid, but keep what the user already read.
    c.items.length = itemIndex + 1;
    const last = c.messages.at(-1);
    const said = last?.role === "assistant" ? assistantText(last) : "";
    if (said) c.items.push({ role: "assistant", content: said });
    const stopped = r.ctl.signal.aborted;
    emit(c, stopped ? { t: "end", status: "stopped" } : { t: "end", status: "error", error: (e as Error).message });
  } finally {
    for (const resolve of r.approvals.values()) resolve(false);
    running.delete(c.meta.id);
    touch(c);
  }
}

// Requests from other sites open in the same browser (CSRF, cross-site WebSocket, DNS rebinding)
// must not reach an agent that can run shell commands.
const HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const trusted = (req: Request) => {
  const origin = req.headers.get("origin");
  if (!HOSTS.includes(req.headers.get("host") ?? "")) return false;
  return origin === null ? req.method === "GET" : HOSTS.some((h) => origin === `http://${h}`);
};
const deny = () => new Response("forbidden", { status: 403 });
const notFound = () => Response.json({ error: "会話が見つかりません" }, { status: 404 });
const guard =
  <R extends Request>(f: (req: R) => Response | Promise<Response>) =>
  (req: R) => (trusted(req) ? f(req) : deny());

const isEffort = (v: unknown): v is Effort => EFFORTS.some((e) => e.id === v);
const isModel = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,64}$/.test(v);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  routes: {
    "/": page,
    "/c/:id": page,

    "/api/state": {
      GET: guard(async () =>
        Response.json({ account: (await hasCred()) ? await account() : null, cwd: CWD, models: MODELS, efforts: EFFORTS, defaultModel: DEFAULT_MODEL }),
      ),
    },
    "/api/login": {
      POST: guard(() => {
        if (!login) {
          login = startLogin(`http://localhost:${PORT}/`);
          login.done
            .then(async () => publish({ type: "auth", account: await account() }))
            .catch(() => {})
            .finally(() => (login = null));
        }
        return Response.json({ url: login.url });
      }),
    },
    "/api/logout": {
      POST: guard(async () => {
        await logout();
        publish({ type: "auth", account: null });
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations": {
      GET: guard(() => Response.json(store.list().map((m) => ({ ...m, running: running.has(m.id) })))),
      POST: guard(async (req) => {
        const b = (await req.json().catch(() => ({}))) as { model?: unknown; effort?: unknown };
        const c = store.create(isModel(b.model) ? b.model : DEFAULT_MODEL, isEffort(b.effort) ? b.effort : "medium");
        publish({ type: "meta", meta: metaOf(c) });
        return Response.json(metaOf(c));
      }),
    },
    "/api/conversations/:id": {
      GET: guard((req) => {
        const c = store.get(req.params.id);
        return c ? Response.json({ meta: metaOf(c), messages: c.messages, seq: seqs.get(c.meta.id) ?? 0 }) : notFound();
      }),
      PATCH: guard(async (req) => {
        const c = store.get(req.params.id);
        if (!c) return notFound();
        const b = (await req.json()) as { title?: unknown; model?: unknown; effort?: unknown };
        if (typeof b.title === "string" && b.title.trim()) c.meta.title = b.title.trim().slice(0, 100);
        if (isModel(b.model)) c.meta.model = b.model;
        if (isEffort(b.effort)) c.meta.effort = b.effort;
        store.save(c);
        publish({ type: "meta", meta: metaOf(c) });
        return Response.json(metaOf(c));
      }),
      DELETE: guard((req) => {
        running.get(req.params.id)?.ctl.abort();
        store.remove(req.params.id);
        publish({ type: "deleted", id: req.params.id });
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations/:id/messages": {
      POST: guard(async (req) => {
        const c = store.get(req.params.id);
        if (!c) return notFound();
        if (running.has(c.meta.id)) return Response.json({ error: "応答の生成中です" }, { status: 409 });
        const b = (await req.json()) as { text?: unknown; images?: unknown; from?: unknown };
        const text = typeof b.text === "string" ? b.text : "";
        const images = Array.isArray(b.images) ? b.images.filter((u): u is string => typeof u === "string" && u.startsWith("data:image/")) : [];
        if (!text.trim() && !images.length) return Response.json({ error: "メッセージが空です" }, { status: 400 });
        // Editing or regenerating: rewind to just before the given user message.
        if (typeof b.from === "string") {
          const at = c.messages.findIndex((m) => m.id === b.from && m.role === "user");
          const m = c.messages[at];
          if (at < 0 || m?.role !== "user") return notFound();
          c.items.length = m.itemIndex;
          emit(c, { t: "truncate", at });
        }
        void runTurn(c, text, images);
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations/:id/stop": {
      POST: guard((req) => {
        running.get(req.params.id)?.ctl.abort();
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations/:id/approve": {
      POST: guard(async (req) => {
        const b = (await req.json()) as { tool?: unknown; ok?: unknown };
        const resolve = typeof b.tool === "string" ? running.get(req.params.id)?.approvals.get(b.tool) : undefined;
        resolve?.(b.ok === true);
        return Response.json({ ok: !!resolve });
      }),
    },
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws" && trusted(req) && req.headers.get("origin") && server.upgrade(req)) return;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("ui");
    },
    message() {},
  },
});

console.log(`shiro: http://localhost:${server.port}/`);
