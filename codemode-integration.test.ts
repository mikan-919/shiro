import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";
import { codeModeEnabled } from "./codemode";
import { createToolRunner } from "./tool-runner";
import { available, usable } from "./tools";
import type { Ev } from "./shared";
import { validateArgs } from "./toolkit";

const dir = mkdtempSync(`${tmpdir()}/shiro-code-integration-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fc = (name: string, args: object): ResponseFunctionToolCall => ({ type: "function_call", call_id: crypto.randomUUID(), name, arguments: JSON.stringify(args) });
function setup(exclusive?: (run: () => Promise<string>) => Promise<string>) {
  const ctl = new AbortController();
  const events: Ev[] = [], trace: { name: string; args: string; output: string }[] = [], said: string[] = [];
  const approvals = new Map<string, (ok: boolean) => void>();
  const call = createToolRunner({
    message: "test", signal: ctl.signal, emit: (e) => { events.push(e); },
    chat: { say: (text) => { said.push(text); }, react: () => true }, team: undefined,
    settings: () => ({ model: "test", autoApprove: false, fullAccess: false }), approvals, cwd: dir, task: "test",
    exclusive: exclusive ?? ((run) => run()), onCall: (v) => { trace.push(v); },
  });
  return { call, ctl, events, approvals, trace, said };
}
async function until(f: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!f()) {
    if (Date.now() > deadline) throw new Error("test did not settle");
    await Bun.sleep(5);
  }
}
const integration = codeModeEnabled() ? test : test.skip;

integration("Code Mode returns filtered file content through the runner and logs inner UI + trace", async () => {
  const path = `${dir}/input.txt`;
  await Bun.write(path, "alpha\nbeta\ngamma");
  const { call, events, trace } = setup();
  const out = JSON.parse(await call(fc("execute_code", { code: `async () => { const text = await tools.read_file({path: ${JSON.stringify(path)}}); return text.split('\\n')[1]; }` })));
  expect(out.result).toBe("beta");
  expect(events.some((e) => e.t === "tool" && e.name === "read_file")).toBe(true);
  expect(events.some((e) => e.t === "tool_status" && e.status === "done" && e.output === "alpha\nbeta\ngamma")).toBe(true);
  expect(trace).toHaveLength(1);
  expect(trace[0]?.name).toBe("read_file");
});

integration("nested bash requests manual approval; denial cannot execute the command", async () => {
  const path = `${dir}/denied.txt`;
  const { call, approvals, events, trace } = setup();
  const result = call(fc("execute_code", { code: `async () => await tools.bash({command: ${JSON.stringify(`printf unsafe > ${path}`)}})` }));
  await until(() => approvals.size === 1);
  expect(await Bun.file(path).exists()).toBe(false);
  approvals.values().next().value!(false);
  expect(JSON.parse(await result).result).toBe("user denied this command");
  expect(await Bun.file(path).exists()).toBe(false);
  expect(events.some((e) => e.t === "tool_status" && e.status === "denied")).toBe(true);
  expect(trace[0]?.output).toBe("user denied this command");
});

integration("nested approved bash executes once, preserving tool output", async () => {
  const { call, approvals, trace } = setup();
  const result = call(fc("execute_code", { code: `async () => await tools.bash({command: 'printf approved'})` }));
  await until(() => approvals.size === 1);
  approvals.values().next().value!(true);
  expect(JSON.parse(await result).result).toBe("exit 0\napproved");
  expect(approvals.size).toBe(0);
  expect(trace[0]?.name).toBe("bash");
});

integration("nested tools reject invalid schemas and unknown names", async () => {
  const { call, said } = setup();
  const result = await call(fc("execute_code", { code: `async () => {
    const results = [];
    results.push(await tools.send_message({text: 123}));
    results.push(await tools.read_file({path: '/missing', extra: true}));
    results.push(await tools.no_such_tool({}));
    return results;
  }` }));
  const out = JSON.parse(result).result as string[];
  expect(out[0]).toContain("must be a string");
  expect(out[1]).toContain("not allowed");
  expect(out[2]).toContain("unknown tool");
  expect(said).toEqual([]);
});

integration("Code Mode refuses recursive execution", async () => {
  const { call } = setup();
  expect(await call(fc("execute_code", { code: `async () => await tools.execute_code({code: 'async () => 1'})` }))).toContain("recursive execute_code");
});

integration("stopping Code Mode clears nested pending approval and leaves no side effect", async () => {
  const path = `${dir}/cancelled.txt`;
  const { call, ctl, approvals } = setup();
  const result = call(fc("execute_code", { code: `async () => await tools.bash({command: ${JSON.stringify(`printf unsafe > ${path}`)}})` }));
  const settled = result.then((output) => ({ output, error: undefined }), (error: unknown) => ({ output: undefined, error }));
  await until(() => approvals.size === 1);
  const lateApproval = approvals.values().next().value!;
  ctl.abort(new Error("test stopped"));
  expect((await settled).error).toBeInstanceOf(Error);
  expect(approvals.size).toBe(0);
  lateApproval(true);
  await Bun.sleep(20);
  expect(await Bun.file(path).exists()).toBe(false);
});

integration("parallel Code Mode writes use the shared exclusive queue without deadlocking outer code", async () => {
  let tail = Promise.resolve("");
  let active = 0, max = 0, count = 0;
  const { call } = setup((run) => {
    const result = tail.then(async () => {
      active++; max = Math.max(max, active); count++;
      await Bun.sleep(5);
      try { return await run(); } finally { active--; }
    });
    tail = result.catch(() => "");
    return result;
  });
  const path = `${dir}/written.txt`;
  const out = JSON.parse(await call(fc("execute_code", { code: `async () => Promise.all([1, 2, 3].map(n => tools.write_file({path: ${JSON.stringify(path)}, content: String(n)})))` })));
  expect(out.result).toHaveLength(3);
  expect(count).toBe(3);
  expect(max).toBe(1);
  expect(await Bun.file(path).text()).toBe("3");
});

integration("disabled tools are neither declared nor callable through Code Mode", async () => {
  const previous = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  try {
    expect(usable("execute_code")!.def.description).not.toContain('"web_search":');
    const { call } = setup();
    const result = await call(fc("execute_code", { code: `async () => tools.web_search({objective: 'test', search_queries: ['test']})` }));
    expect(JSON.parse(result).result).toContain("unknown tool web_search");
  } finally {
    if (previous === undefined) delete process.env.PARALLEL_API_KEY;
    else process.env.PARALLEL_API_KEY = previous;
  }
});

integration("cancelled queued writes cannot run when the exclusive gate later opens", async () => {
  const gate = Promise.withResolvers<void>();
  let queued = false;
  let work: Promise<string> | undefined;
  const path = `${dir}/cancelled-queue.txt`;
  const { call, ctl } = setup((run) => {
    queued = true;
    work = gate.promise.then(run);
    return work;
  });
  const settled = call(fc("execute_code", { code: `async () => tools.write_file({path: ${JSON.stringify(path)}, content: 'unsafe'})` }))
    .then(() => false, () => true);
  await until(() => queued);
  ctl.abort(new Error("cancel queued write"));
  expect(await settled).toBe(true);
  gate.resolve();
  await work?.catch(() => {});
  expect(await Bun.file(path).exists()).toBe(false);
});

test("direct tools remain available and schemas validate required string/array arguments", () => {
  expect(available().some((t) => t.def.name === "read_file")).toBe(true);
  expect(() => validateArgs(usable("read_file")!, { path: 12 })).toThrow("must be a string");
  expect(() => validateArgs(usable("read_file")!, {})).toThrow("is required");
  const read = usable("read_file")!;
  expect(() => validateArgs(read, { path: "okay" })).not.toThrow();
});

integration("Code Mode describes available tool signatures", () => {
  const description = usable("execute_code")!.def.description;
  expect(description).toContain('"read_file": (args: { "path": string; "start_line"?: number; "end_line"?: number }) => Promise<string>');
  expect(description).toContain('"bash":');
  expect(description).not.toContain('"execute_code":');
});
