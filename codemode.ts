// Local Code Mode. Only bubblewrap is a security boundary; never fall back to eval in the host.
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const FRAME = 256_000;
const TOTAL = 2_000_000;
export const CODE_TIMEOUT_MS = 120_000;
const runtime = () => {
  const bwrap = Bun.which("bwrap"), node = Bun.which("node"), prlimit = Bun.which("prlimit");
  if (process.platform !== "linux" || !bwrap || !node || !prlimit) return undefined;
  return { bwrap: realpathSync(bwrap), node: realpathSync(node), prlimit: realpathSync(prlimit) };
};
/** Availability is a dependency check, not proof that user namespaces work. Startup failures fail closed. */
export const codeModeEnabled = () => process.env.SHIRO_CODE_MODE !== "0" && !!runtime();
type Dispatch = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;

export async function executeCode(code: string, dispatch: Dispatch, signal: AbortSignal, options: { timeoutMs?: number } = {}): Promise<string> {
  signal.throwIfAborted();
  if (!codeModeEnabled()) throw new Error("Code Mode requires Linux, bubblewrap, prlimit and Node.js (or is disabled by SHIRO_CODE_MODE=0)");
  if (Buffer.byteLength(code) > 64_000) throw new Error("code size limit exceeded");
  const { bwrap, node, prlimit } = runtime()!;
  const dir = mkdtempSync(`${tmpdir()}/shiro-code-`);
  const ctl = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let fail!: (e: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { fail = reject; });
  // Install before any await, so setup is also cancellable.
  const stop = (reason: unknown) => {
    if (finished) return;
    ctl.abort(reason);
    child?.kill("SIGKILL");
    fail(reason instanceof Error ? reason : new Error(String(reason)));
  };
  const abort = () => stop(signal.reason ?? new Error("Code Mode cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => stop(new Error("Code Mode timed out")), options.timeoutMs ?? CODE_TIMEOUT_MS);
  try {
    const work = (async () => {
      const source = await Bun.file(new URL("./codemode-child.ts", import.meta.url)).text();
      ctl.signal.throwIfAborted();
      writeFileSync(`${dir}/runner.mjs`, new Bun.Transpiler({ loader: "ts", target: "node" }).transformSync(source), { mode: 0o600 });
      const args = [prlimit, "--as=1073741824", "--cpu=60", "--fsize=1048576", "--nofile=64", "--core=0", "--", bwrap, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv"];
      // Runtime-only mounts. Never bind cwd, home, credentials, /run, or host /tmp.
      for (const path of ["/nix/store", "/usr", "/bin", "/lib", "/lib64"]) {
        if (existsSync(path)) args.push("--ro-bind", path, path);
      }
      if (existsSync("/etc/ld.so.cache")) args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
      args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/tmp", "--ro-bind", `${dir}/runner.mjs`, "/runner.mjs", "--", node,
        "--jitless", "--disable-wasm-trap-handler", "--max-old-space-size=64", "--permission", "--allow-fs-read=*", "--no-addons", "--disable-proto=throw", "/runner.mjs");
      child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} });
      const input = child.stdin as Bun.FileSink;
      const send = (v: unknown) => {
        if (ctl.signal.aborted) return;
        try { input.write(JSON.stringify(v) + "\n"); } catch (e) { stop(e); }
      };
      send({ code });
      let stderr = "";
      const drainErrors = (async () => {
        for await (const chunk of child!.stderr as ReadableStream<Uint8Array>) {
          stderr += new TextDecoder().decode(chunk);
          if (stderr.length > 16_000) throw new Error("sandbox stderr limit exceeded");
        }
      })();
      drainErrors.catch(stop);
      let buffer = "", total = 0, count = 0, active = 0;
      const seen = new Set<number>();
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        ctl.signal.throwIfAborted();
        total += chunk.byteLength;
        if (total > TOTAL) throw new Error("sandbox output limit exceeded");
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (Buffer.byteLength(line) > FRAME) throw new Error("sandbox frame limit exceeded");
          const msg = JSON.parse(line);
          if (msg.type === "done") {
            if (active) throw new Error("all tool calls must be awaited");
            const output = JSON.stringify({ result: msg.result, logs: msg.logs });
            if (Buffer.byteLength(output) > FRAME) throw new Error("result size limit exceeded");
            return output;
          }
          if (msg.type === "error") throw new Error(String(msg.error));
          if (msg.type !== "call" || !Number.isSafeInteger(msg.id) || seen.has(msg.id) || typeof msg.name !== "string" || !msg.args || typeof msg.args !== "object" || Array.isArray(msg.args)) throw new Error("invalid sandbox RPC");
          seen.add(msg.id);
          if (++count > 100 || active >= 8) throw new Error("tool call limit exceeded (100 total, 8 concurrent)");
          if (msg.name === "execute_code") throw new Error("recursive execute_code is not allowed");
          active++;
          void (async () => {
            try {
              ctl.signal.throwIfAborted();
              const output = await dispatch(msg.name, msg.args, ctl.signal);
              if (typeof output !== "string" || Buffer.byteLength(output) > FRAME / 2) throw new Error("tool result size limit exceeded");
              send({ id: msg.id, output });
            } catch (e) { send({ id: msg.id, error: String(e) }); }
            finally { active--; }
          })();
        }
        if (Buffer.byteLength(buffer) > FRAME) throw new Error("sandbox frame limit exceeded");
      }
      await drainErrors;
      const exit = await child.exited;
      throw new Error(`sandbox exited (${exit}): ${stderr.trim().slice(0, 2000) || "no result"}`);
    })();
    return await Promise.race([work, stopped]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    ctl.abort(new Error("Code Mode finished"));
    child?.kill("SIGKILL");
    if (child) {
      try { (child.stdin as Bun.FileSink).end(); } catch { /* Already closed on cancellation. */ }
      await child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
