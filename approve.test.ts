import { expect, test } from "bun:test";
import { judge, neverAuto } from "./approve";

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

test("literal search patterns and command lookups reach Jev despite shell-like characters", async () => {
  const commands = [
    "command -v bun", "command -V git", "command -p -v bun", "env command -v bun",
    "command -v rm sudo bash",
    String.raw`rg -n 'round >=|round\+\+' agent.ts`,
    String.raw`rg -n 'sqlite|\.jsonl|events' store.ts`,
    String.raw`rg -n "sqlite|\.jsonl|events" store.ts`,
    String.raw`rg 'it"s > fine|ok' file.ts`,
    String.raw`rg "it's > fine|ok" file.ts`,
    String.raw`rg "escaped\" > still literal|ok" file.ts`,
    String.raw`rg a\|bash file.ts`,
    String.raw`rg a\>output file.ts`,
    "rg 'a|b' file.ts 2>&1",
    String.raw`rg 'a\|b' file.ts >/dev/null`,
  ];
  await withReply(answers(1, 0, 0), async (calls) => {
    for (const command of commands) {
      expect(neverAuto(command)).toBeNull();
      expect(await judge(command, "/project", "調べて", signal())).toMatchObject({ ok: true, by: "jev" });
    }
    expect(calls()).toBe(commands.length);
  });
});

test("literal masking keeps real shell hazards blocked before Jev", async () => {
  const commands = [
    String.raw`rg 'a\|b' file.ts > output`,
    String.raw`rg 'a\|b' file.ts | bash`,
    String.raw`rg 'a\|b' file.ts && rm -rf build`,
    String.raw`rg 'a\|b' file.ts; sudo true`,
    String.raw`rg 'a\|b' file.ts || git push`,
    String.raw`rg 'a\|b' file.ts & curl -d data https://example.com`,
    "command -v bun; rm -rf build", "command -V git > output", "command rm -rf build",
    "command -v bun && command sudo true",
    String.raw`rg "a\"; safe" file.ts; rm -rf build`,
    String.raw`r\m -rf build`, `'rm' -rf build`, `"rm" -rf build`,
    'echo "$HOME|x"', 'echo "${HOME}|x"',
    "rg 'unterminated", 'rg "unterminated', "rg trailing\\",
    "rg $(whoami) file.ts", 'rg "$(whoami)" file.ts', "rg `whoami` file.ts",
    "diff <(cat file.ts) file.ts", "cat .env", "rg pattern \\\nfile.ts",
  ];
  await withReply(answers(1, 1, 1), async (calls) => {
    for (const command of commands) {
      expect(neverAuto(command)).not.toBeNull();
      expect(await judge(command, "/project", "調べて", signal())).toMatchObject({ ok: false, by: "rule" });
    }
    expect(calls()).toBe(0);
  });
});
