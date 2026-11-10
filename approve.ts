// Automatic approval of shell commands with TypeSafe AI's Jev (https://docs.typesafe.ai/api).
// A static rule list runs first; anything it flags always goes to the user. The rest is asked to Jev,
// and runs without a prompt when it is a pure read, or when it is both undoable and on task. Any failure falls back to the user.

import type { Judge } from "./shared";

const API = process.env.SHIRO_JEV_URL ?? "https://api.typesafe.ai/v1/systemone";
// Pinned: the thresholds below were measured against this version, and "jev-latest" moves.
const MODEL = process.env.SHIRO_JEV_MODEL ?? "jev-1.14.0";
const THRESHOLD = 0.9;
// Measured against jev-1.14: pure reads scored 0.87-0.98 (git status is the low one: it may refresh the index),
// state-changing commands 0.06 or less. 0.8 keeps git status in without coming near the writes.
const READ_THRESHOLD = 0.8;

export const jevEnabled = () => !!process.env.TYPESAFE_API_KEY;

// Shapes that never run unattended, whatever Jev says. Checked per simple command after normalising.
const RISKY: [RegExp, string][] = [
  [/^(\S*['"\\=$]|[-0-9])/, "引用符や変数を含む、解釈の難しいコマンドです"],
  [/^(sudo|doas|su|pkexec)\b/, "管理者権限で実行するコマンドです"],
  [/^(bash|sh|zsh|fish|dash|eval|source|\.|xargs|exec)\b/, "別のシェルやコマンドを起動するコマンドです"],
  [/^(node|bun|deno|python3?|ruby|perl|php)\s+(-\S+\s+)*(-c|-e|-p|--eval|--print)\b/, "スクリプトをその場で実行するコマンドです"],
  [/^rm\s+(-\S*[rRf]\S*\s+)+/, "ファイルを再帰的または強制的に削除するコマンドです"],
  [/^(dd|mkfs\S*|shred|chmod|chown|chgrp|mount|umount|kill|pkill|killall|reboot|shutdown|systemctl|crontab)\b/, "システムに影響するコマンドです"],
  [/^git\b.*\b(push|reset\s+--hard|clean\s+-\S*[fdx]|branch\s+-D|checkout\s+--|restore|rebase|filter-branch|update-ref|reflog\s+expire|gc\b)/, "取り消しの難しい Git の操作です"],
  [/^(npm|pnpm|yarn|bun)\s+publish\b|^cargo\s+publish\b|^gh\s+(release|repo\s+delete|pr\s+merge)\b/, "外部に公開する操作です"],
  [/^(wrangler|vercel|fly|flyctl|netlify)\s+deploy\b|^terraform\s+(apply|destroy)\b|^kubectl\s+(delete|apply)\b|^docker\s+(rm|rmi|system\s+prune)\b/, "デプロイや外部環境を変える操作です"],
  [/^(curl|wget)\b.*\s(-d|--data\S*|-X\s*(POST|PUT|PATCH|DELETE)|-T|--upload-file|-o|-O)\b/, "外部へ送信またはファイルを書き込む通信です"],
  [/^(ssh|scp|rsync|sftp|nc|ncat|telnet)\b/, "他のマシンに接続するコマンドです"],
];
const SECRETS = /\.env\b|\.ssh\b|\.aws\b|\.npmrc\b|\.netrc\b|\.gnupg\b|credentials|id_rsa|id_ed25519|\.shiro\b/i;
const KEYWORDS = /^(if|then|elif|else|fi|while|until|do|done|for|in|case|esac|!)(\s+|$)/;
const WRAPPERS = /^(command|builtin|env|nohup|time|timeout|nice|watch|npx|bunx|pnpx)(\s+|$)/;
const ASSIGN = /^[A-Za-z_]\w*=[^\s'"`$\\]*(\s+|$)/;

function normalise(s: string): string {
  let prev: string;
  do {
    prev = s;
    // "/usr/bin/git" and "./node_modules/.bin/tsc" are judged by their command name.
    s = s.trim().replace(KEYWORDS, "").replace(WRAPPERS, "").replace(ASSIGN, "").replace(/^\\/, "").replace(/^\S*\/(?=\S)/, "");
  } while (s !== prev);
  return s;
}

/** Returns why a command must be confirmed by the user, or null if Jev may decide. */
export function neverAuto(command: string): string | null {
  if (/\$\(|<\(|>\(|`|\\\n/.test(command)) return "コマンド置換を含むコマンドです";
  if (SECRETS.test(command)) return "認証情報に触れる可能性があります";
  // A quoted argument is one literal word (a grep pattern with | or > in it), so empty it before splitting.
  // The quotes stay, so a quoted command name or a leftover unpaired quote still trips the first rule.
  // One left-to-right pass, so a ' inside "..." is not taken as an opening quote; a backslash could escape a quote, so skip it then.
  const unquoted = command.includes("\\") ? command : command.replace(/'[^']*'|"[^"$`]*"/g, (q) => q[0]! + q[0]);
  // Redirects that only merge or discard output write no file; drop them before looking further.
  const plain = unquoted.replace(/\d*>&\d|&>\s*\/dev\/null|\d*>\s*\/dev\/null/g, " ");
  if (/>/.test(plain)) return "リダイレクトでファイルに書き込むコマンドです";
  for (const piece of plain.split(/&&|\|\||[;|&\n(){}]/)) {
    const cmd = normalise(piece);
    if (!cmd) continue;
    for (const [re, why] of RISKY) if (re.test(cmd)) return why;
  }
  return null;
}

const QUESTIONS = {
  // Inspection is a reasonable step toward almost any task, and Jev judges "serves the task" narrowly
  // (a terse "続けて" or an indirect step scores low). So a pure read is approved on this question alone.
  read_only: {
    type: "noul",
    instructions:
      "Every command in `commands` only reads or lists information inside `project` (file contents, directory listings, " +
      "git status, history or diffs, search results) and prints it. It creates, modifies or deletes nothing and sends nothing over the network.",
    criteria: {
      true: "Pure inspection: the only effect is printed output.",
      false: "Anything is written, changed, deleted, installed, built, executed as a test, or sent.",
    },
  },
  reversible: {
    type: "noul",
    instructions:
      "Every command in `commands` only reads, or changes files inside `project`, and its effects can be undone with git or by running it again. " +
      "None of them deletes data outside version control, touches credentials or secrets, changes the system or other users' files, sends data to the network, or affects anything outside `project`.",
  },
  serves_task: {
    type: "noul",
    instructions: "Running `commands` is a reasonable next step toward `task`.",
  },
} as const;

export async function judge(command: string, project: string, task: string, signal: AbortSignal): Promise<Judge> {
  const rule = neverAuto(command);
  if (rule) return { ok: false, by: "rule", reason: rule };
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: { commands: [command], project, task }, questions: QUESTIONS }),
      signal: AbortSignal.any([AbortSignal.timeout(8000), signal]),
    });
    if (!res.ok) return { ok: false, by: "error", reason: `Jev が応答しませんでした（${res.status}）` };
    const j = (await res.json()) as { answers?: Record<string, { noul?: unknown }> };
    const readOnly = j.answers?.read_only?.noul;
    const reversible = j.answers?.reversible?.noul;
    const serves = j.answers?.serves_task?.noul;
    const valid = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;
    if (!valid(readOnly) || !valid(reversible) || !valid(serves)) return { ok: false, by: "error", reason: "Jev の応答を読み取れませんでした" };
    const ok = readOnly >= READ_THRESHOLD || (reversible >= THRESHOLD && serves >= THRESHOLD);
    return {
      ok,
      by: "jev",
      readOnly,
      reversible,
      servesTask: serves,
      reason: ok ? undefined : reversible < THRESHOLD ? "取り消せる操作だと判定できませんでした" : "依頼に沿った操作だと判定できませんでした",
    };
  } catch (e) {
    if (signal.aborted) throw e;
    return { ok: false, by: "error", reason: (e as Error).name === "TimeoutError" ? "Jev の判定が時間内に終わりませんでした" : "Jev に接続できませんでした" };
  }
}
