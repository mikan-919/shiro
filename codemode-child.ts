// Runs only inside bubblewrap. vm supplies a small API, NOT the security boundary.
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";

const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
let next = 0;
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();
let started = false;
const logs: string[] = [];
let logSize = 0;
const print = (...values: unknown[]) => {
  const text = values.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ");
  logSize += text.length;
  if (logSize > 16_000) throw new Error("console output limit exceeded");
  logs.push(text);
};
const tools = new Proxy(Object.create(null), {
  get(_, name) {
    if (typeof name !== "string" || name === "then") return undefined;
    return (args: unknown) => new Promise<string>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ type: "call", id, name, args });
    });
  },
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (!started) {
      started = true;
      const fn = runInNewContext(`(${msg.code})`, { tools, console: { log: print, info: print, warn: print, error: print } });
      if (typeof fn !== "function") throw new Error("code must be an async function expression");
      const result = await fn();
      if (pending.size) throw new Error("all tool calls must be awaited");
      send({ type: "done", result: result === undefined ? null : result, logs });
    } else {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.output);
    }
  } catch (e) {
    send({ type: "error", error: String(e) });
  }
});
