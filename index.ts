// HTTP and WebSocket front door. Requests are validated here and handed to the agent.
import page from "./web/index.html";
import { account, login, logout } from "./auth";
import { createAgent } from "./agent";
import { colony, decide } from "./evolver";
import { stopObserving } from "./observer";
import { jevEnabled } from "./approve";
import { isEffort, MODELS, type Push } from "./shared";

const PORT = Number(process.env.SHIRO_PORT ?? 3000);
const ORIGIN = `http://localhost:${PORT}`;
const CWD = process.cwd();
const defaultModel = process.env.SHIRO_MODEL ?? MODELS[0].id;

const publish = (p: Push) => server.publish("ui", JSON.stringify(p));
const agent = createAgent({ publish, cwd: CWD, defaultModel });

// Requests from other sites open in the same browser (CSRF, cross-site WebSocket, DNS rebinding)
// must not reach an agent that can run shell commands.
const HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const trusted = (req: Request) => {
  const origin = req.headers.get("origin");
  if (!HOSTS.includes(req.headers.get("host") ?? "")) return false;
  return origin === null ? req.method === "GET" : HOSTS.some((h) => origin === `http://${h}`);
};
const guard =
  <R extends Request>(f: (req: R) => Response | Promise<Response>) =>
  (req: R) => (trusted(req) ? f(req) : new Response("forbidden", { status: 403 }));

const notFound = () => Response.json({ error: "会話が見つかりません" }, { status: 404 });
const body = (req: Request) => req.json().catch(() => ({})) as Promise<Record<string, unknown>>;

const isModel = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,64}$/.test(v);
const settingsIn = (b: Record<string, unknown>) => ({
  ...(isModel(b.model) && { model: b.model }),
  ...(isEffort(b.effort) && { effort: b.effort }),
  ...(typeof b.autoApprove === "boolean" && { autoApprove: b.autoApprove }),
  ...(typeof b.fullAccess === "boolean" && { fullAccess: b.fullAccess }),
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  routes: {
    "/": page,
    "/c/:id": page,
    "/c/:id/context": page,

    "/api/state": {
      GET: guard(async () => Response.json({ account: await account(), cwd: CWD, defaultModel, jev: jevEnabled() })),
    },
    "/api/login": {
      POST: guard(() => {
        const l = login(`${ORIGIN}/`);
        l.done.then(
          async () => publish({ type: "auth", account: await account() }),
          (e: Error) => publish({ type: "auth", account: null, error: `ログインできませんでした: ${e.message}` }),
        );
        return Response.json({ url: l.url });
      }),
    },
    "/api/logout": {
      POST: guard(async () => {
        await logout();
        publish({ type: "auth", account: null });
        return Response.json({ ok: true });
      }),
    },
    "/api/colony": {
      GET: guard(() => Response.json(colony())),
    },
    "/api/colony/decide": {
      POST: guard(async (req) => {
        const b = await body(req);
        if ((b.action !== "adopt" && b.action !== "reject") || typeof b.target !== "number") return Response.json({ error: "不正な要求です" }, { status: 400 });
        try {
          decide(b.action, b.target);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 409 });
        }
        return Response.json(colony());
      }),
    },
    // Both jobs run in the background; a "colony" push tells the page when to load the colony again.
    "/api/colony/observe": {
      POST: guard(() => (agent.observePast(), Response.json(colony()))),
      DELETE: guard(() => (stopObserving(), Response.json(colony()))),
    },
    "/api/colony/evolve": {
      POST: guard(() => (agent.evolveNow(), Response.json(colony()))),
    },
    "/api/conversations": {
      GET: guard(() => Response.json(agent.list())),
      POST: guard(async (req) => Response.json(agent.create(settingsIn(await body(req))))),
    },
    "/api/conversations/:id": {
      GET: guard((req) => {
        const c = agent.open(req.params.id);
        return c ? Response.json(c) : notFound();
      }),
      PATCH: guard(async (req) => {
        const b = await body(req);
        const title = typeof b.title === "string" && b.title.trim() ? { title: b.title.trim().slice(0, 100) } : {};
        const meta = agent.update(req.params.id, { ...settingsIn(b), ...title });
        return meta ? Response.json(meta) : notFound();
      }),
      DELETE: guard((req) => {
        agent.remove(req.params.id);
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations/:id/messages": {
      POST: guard(async (req) => {
        const b = await body(req);
        const text = typeof b.text === "string" ? b.text : "";
        const images = Array.isArray(b.images) ? b.images.filter((u): u is string => typeof u === "string" && u.startsWith("data:image/")) : [];
        if (!text.trim() && !images.length) return Response.json({ error: "メッセージが空です" }, { status: 400 });
        const result = agent.send(req.params.id, text, images, typeof b.from === "string" ? b.from : undefined);
        if (result === "missing") return notFound();
        if (result === "busy") return Response.json({ error: "応答の生成中です" }, { status: 409 });
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations/:id/stop": {
      POST: guard((req) => {
        agent.stop(req.params.id);
        return Response.json({ ok: true });
      }),
    },
    "/api/conversations/:id/react": {
      POST: guard(async (req) => {
        const b = await body(req);
        const emoji = typeof b.emoji === "string" && b.emoji.length <= 16 ? b.emoji : null;
        return Response.json({ ok: typeof b.target === "string" && agent.react(req.params.id, b.target, emoji) });
      }),
    },
    "/api/conversations/:id/approve": {
      POST: guard(async (req) => {
        const b = await body(req);
        return Response.json({ ok: typeof b.call === "string" && agent.approve(req.params.id, b.call, b.ok === true) });
      }),
    },
  },
  fetch(req, server) {
    // A WebSocket upgrade is a GET, so require the Origin header that browsers always send with it.
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
