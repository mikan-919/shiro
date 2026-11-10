import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { codeModeEnabled, executeCode } from "./codemode";

const sandboxTest = codeModeEnabled() ? test : test.skip;
const run = (code: string) => executeCode(code, async (name, args) => JSON.stringify({ name, args }), new AbortController().signal);

sandboxTest("Code Mode batches tools, transforms results and captures console", async () => {
  const result = JSON.parse(await run(`async () => {
    const out = await Promise.all([tools.read_file({path:'a'}), tools.read_file({path:'b'})]);
    console.log('two files');
    return out.map(x => JSON.parse(x).args.path).join(',');
  }`));
  expect(result).toEqual({ result: "a,b", logs: ["two files"] });
});

sandboxTest("OS boundary holds even after escaping vm: no host files, env or network", async () => {
  const dir = mkdtempSync(`${tmpdir()}/shiro-secret-`);
  writeFileSync(`${dir}/private`, "not for sandbox");
  process.env.SHIRO_SANDBOX_TEST_SECRET = "not for sandbox";
  try {
    const result = JSON.parse(await run(`async () => {
      const p = tools.anything.constructor('return process')();
      const fs = p.getBuiltinModule('node:fs');
      const connected = await new Promise(resolve => {
        const s = p.getBuiltinModule('node:net').createConnection({host:'1.1.1.1',port:80});
        s.on('connect',()=>{s.destroy();resolve(true)}).on('error',()=>resolve(false));
      });
      return { connected, file: fs.existsSync(${JSON.stringify(`${dir}/private`)}),
        env: p.env.SHIRO_SANDBOX_TEST_SECRET ?? null,
        routes: fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length,
        home: fs.existsSync(${JSON.stringify(process.env.HOME ?? "/home/nixos")}) };
    }`));
    expect(result.result).toEqual({ connected: false, file: false, env: null, routes: 1, home: false });
  } finally { delete process.env.SHIRO_SANDBOX_TEST_SECRET; rmSync(dir, { recursive: true, force: true }); }
});

sandboxTest("resource caps hold and Node denies subprocesses even after vm escape", async () => {
  const result = JSON.parse(await run(`async () => {
    const p = tools.anything.constructor('return process')();
    const limits = p.getBuiltinModule('node:fs').readFileSync('/proc/self/limits','utf8');
    let subprocess = '', memory = '';
    try { p.getBuiltinModule('node:child_process').spawnSync(p.execPath, ['-e', '0']); }
    catch (e) { subprocess = e.code; }
    try { p.getBuiltinModule('node:buffer').Buffer.alloc(2 * 1024 * 1024 * 1024); }
    catch (e) { memory = e.name; }
    return { limits, subprocess, memory };
  }`));
  expect(result.result.limits).toMatch(/Max address space\s+1073741824\s+1073741824/);
  expect(result.result.limits).toMatch(/Max cpu time\s+60\s+60/);
  expect(result.result.subprocess).toBe("ERR_ACCESS_DENIED");
  expect(result.result.memory).toBe("RangeError");
});

sandboxTest("infinite loops time out and external cancellation kills execution", async () => {
  const start = Date.now();
  await expect(executeCode("async()=>{ while(true){} }", async () => "", new AbortController().signal, { timeoutMs: 200 })).rejects.toThrow("timed out");
  expect(Date.now() - start).toBeLessThan(3000);
  const ctl = new AbortController();
  const pending = executeCode("async()=>{ while(true){} }", async () => "", ctl.signal);
  setTimeout(() => ctl.abort(new Error("stopped by test")), 100);
  await expect(pending).rejects.toThrow("stopped by test");
});

sandboxTest("timeout aborts pending RPC dispatch", async () => {
  let inner: AbortSignal | undefined;
  await expect(executeCode("async()=>await tools.wait({})", async (_, __, signal) => {
    inner = signal;
    return await new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("cancelled")));
  }, new AbortController().signal, { timeoutMs: 300 })).rejects.toThrow("timed out");
  expect(inner?.aborted).toBe(true);
});

sandboxTest("recursive calls, oversized code/output, unawaited calls and bad JS fail closed", async () => {
  await expect(run("async()=>await tools.execute_code({code:'x'})")).rejects.toThrow("recursive");
  await expect(run(" ".repeat(64_001))).rejects.toThrow("code size");
  await expect(run("async()=> 'x'.repeat(300000)")).rejects.toThrow("frame limit");
  await expect(run("async()=>{ tools.read_file({path:'x'}); return 'no'; }")).rejects.toThrow("awaited");
  await expect(run("async()=>{" )).rejects.toThrow();
});

sandboxTest("RPC concurrency is bounded", async () => {
  await expect(executeCode("async()=>await Promise.all(Array.from({length:9},()=>tools.wait({})))", async () => await new Promise<string>(() => {}), new AbortController().signal)).rejects.toThrow("tool call limit");
});

test("disabled Code Mode cannot start a sandbox", async () => {
  const before = process.env.SHIRO_CODE_MODE;
  process.env.SHIRO_CODE_MODE = "0";
  try {
    expect(codeModeEnabled()).toBe(false);
    await expect(run("async()=>1")).rejects.toThrow("disabled");
  } finally { if (before === undefined) delete process.env.SHIRO_CODE_MODE; else process.env.SHIRO_CODE_MODE = before; }
});
