import OpenAI from "openai";
import type { ResponseInputItem, ResponseFunctionToolCall } from "openai/resources/responses/responses";
import { getCred, hasCred, startLogin } from "./auth";
import page from "./index.html";
import { TOOLS, runTool } from "./tools";

const MODEL = process.env.SHIRO_MODEL ?? "gpt-6.1-sol";
const PORT = Number(process.env.SHIRO_PORT ?? 3000);

// One conversation per server process, shared by every open tab.
type UIEvent = { type: string; [k: string]: unknown };
const session = crypto.randomUUID();
const instructions = `You are a coding agent working in ${process.cwd()}. Use the tools to inspect and change files. Be concise.`;
const input: ResponseInputItem[] = []; // ponytail: full history resent each turn, add compaction when context fills up
const log: UIEvent[] = []; // replayed to tabs that connect later
const pending = new Map<string, (ok: boolean) => void>();
let busy = false;
let login: ReturnType<typeof startLogin> | null = null;

function emit(e: UIEvent) {
  log.push(e);
  server.publish("ui", JSON.stringify(e));
}

const confirm = (command: string) =>
  new Promise<boolean>((resolve) => {
    const id = crypto.randomUUID();
    pending.set(id, resolve);
    emit({ type: "confirm", id, command });
  });

async function runTurn(text: string) {
  busy = true;
  const start = input.length;
  emit({ type: "user", text });
  input.push({ role: "user", content: text });
  try {
    while (true) {
      const { access, accountId } = await getCred();
      const client = new OpenAI({
        apiKey: access,
        baseURL: "https://chatgpt.com/backend-api/codex",
        defaultHeaders: { "chatgpt-account-id": accountId, "OpenAI-Beta": "responses=experimental", originator: "shiro", "session-id": session },
      });
      const stream = await client.responses.create({
        model: MODEL, instructions, input, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: true,
        store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: session,
      });
      const calls: ResponseFunctionToolCall[] = [];
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") emit({ type: "delta", text: ev.delta });
        else if (ev.type === "response.output_item.done") {
          input.push(ev.item as ResponseInputItem);
          if (ev.item.type === "function_call") calls.push(ev.item);
        } else if (ev.type === "response.failed") throw new Error(ev.response.error?.message ?? "response failed");
      }
      if (!calls.length) break;

      for (const c of calls) {
        emit({ type: "tool", name: c.name, args: c.arguments });
        let output: string;
        try {
          output = String(await runTool(c.name, JSON.parse(c.arguments), confirm));
        } catch (e) {
          output = `error: ${(e as Error).message}`;
        }
        emit({ type: "tool_result", output });
        input.push({ type: "function_call_output", call_id: c.call_id, output });
      }
    }
  } catch (e) {
    input.length = start; // drop the half-finished turn so the next request is valid
    emit({ type: "error", message: (e as Error).message });
  } finally {
    busy = false;
    emit({ type: "done" });
  }
}

// Blocks other sites open in the browser from driving this agent (it can run shell commands).
const sameOrigin = (req: Request) =>
  [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.get("origin") ?? "");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  routes: {
    "/": page,
    "/login": {
      POST: (req) => {
        if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
        if (!login) {
          login = startLogin(`http://localhost:${PORT}/`);
          login.done.then(
            () => emit({ type: "auth", ok: true }),
            (e: Error) => emit({ type: "error", message: e.message }),
          ).finally(() => (login = null));
        }
        return Response.json({ url: login.url });
      },
    },
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws" && sameOrigin(req) && server.upgrade(req)) return;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      ws.subscribe("ui");
      for (const e of log) ws.send(JSON.stringify(e));
      ws.send(JSON.stringify({ type: "auth", ok: await hasCred() }));
    },
    message(_ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.type === "prompt" && typeof m.text === "string" && m.text.trim() && !busy) void runTurn(m.text);
      else if (m.type === "answer") {
        const resolve = pending.get(m.id);
        if (!resolve) return;
        pending.delete(m.id);
        emit({ type: "confirmed", id: m.id, ok: m.ok === true });
        resolve(m.ok === true);
      }
    },
  },
});

console.log(`shiro: http://localhost:${PORT}/`);
