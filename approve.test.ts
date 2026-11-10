import { expect, test } from "bun:test";
import { judge } from "./approve";

const signal = () => new AbortController().signal;
const answers = (read: unknown, reversible: unknown, serves: unknown) => ({
  answers: { read_only: { noul: read }, reversible: { noul: reversible }, serves_task: { noul: serves } },
});

// No external API requests; restore fetch even when an assertion throws.
async function withReply(body: unknown, run: (calls: () => number) => Promise<void>, status = 200) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    return Response.json(body, { status });
  }, { preconnect: original.preconnect });
  try { await run(() => calls); } finally { globalThis.fetch = original; }
}

async function score(read: number, reversible: number, serves: number) {
  let result: Awaited<ReturnType<typeof judge>> | undefined;
  await withReply(answers(read, reversible, serves), async (calls) => {
    result = await judge("bun test", "/project", "テストして", signal());
    expect(calls()).toBe(1);
  });
  return result!;
}

test("judge retains static blocks even when Jev would approve", async () => {
  await withReply(answers(1, 1, 1), async (calls) => {
    for (const command of ["rm -rf build", "git push origin main", "cat .env", "sudo true"]) {
      expect(await judge(command, "/project", "作業を続けて", signal())).toMatchObject({ ok: false, by: "rule" });
    }
    expect(calls()).toBe(0);
  });
});

test("judge preserves valid scores and rejects scores that cannot justify approval", async () => {
  expect(await score(1, 0, 0)).toMatchObject({ ok: true, by: "jev", readOnly: 1, reversible: 0, servesTask: 0 });
  expect(await score(0, 1, 1)).toMatchObject({ ok: true, by: "jev" });
  expect(await score(0, 0, 1)).toMatchObject({ ok: false, by: "jev" });
  expect(await score(0, 1, 0)).toMatchObject({ ok: false, by: "jev" });
});

test("judge uses inclusive 80% read, 50% reversible, and 30% task boundaries", async () => {
  for (const [read, reversible, serves, ok] of [
    [0.8, 0, 0, true], [0.7999, 0, 0, false],
    [0, 0.5, 0.3, true], [0, 0.4999, 1, false], [0, 1, 0.2999, false],
    // Replayed scores reported from actual session denials: ordinary checks and a project edit.
    [0, 0.68, 0.76, true], [0, 0.5, 0.34, true], [0, 0.94, 0.41, true],
    // Outside-project script execution and modification remain below the reversible boundary.
    [0, 0.39, 0.67, false], [0, 0.08, 0.38, false],
  ] as const) {
    expect(await score(read, reversible, serves)).toMatchObject({ ok, by: "jev" });
  }
});

test("judge fails closed for missing, nonnumeric, and out-of-range scores", async () => {
  for (const body of [
    {}, { answers: {} },
    answers("1", 1, 1), answers(1, null, 1), answers(1, 1, undefined),
    answers(-0.01, 1, 1), answers(1, 1.01, 1), answers(1, 1, -1),
  ]) {
    await withReply(body, async () => {
      expect(await judge("bun test", "/project", "テストして", signal())).toMatchObject({ ok: false, by: "error" });
    });
  }
});

test("judge falls back to manual approval for HTTP and network failures", async () => {
  await withReply({}, async () => {
    expect(await judge("bun test", "/project", "テストして", signal())).toMatchObject({ ok: false, by: "error" });
  }, 503);
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => { throw new TypeError("offline"); }, { preconnect: original.preconnect });
  try {
    expect(await judge("bun test", "/project", "テストして", signal())).toMatchObject({ ok: false, by: "error" });
  } finally { globalThis.fetch = original; }
});
