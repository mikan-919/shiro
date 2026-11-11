import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPage, noteKind } from "./context";
import type { Board } from "../shared";

test("note conventions classify failures and type gaps without treating arbitrary errors as types", () => {
  expect(noteKind("Chat: hello")).toBe("chat");
  expect(noteKind("  [failure] command failed")).toBe("failure");
  expect(noteKind("[type-gap] unknown coordination cost")).toBe("type-gap");
  expect(noteKind("tool error without published label")).toBe("finding");
  expect(noteKind("A reference to [failure] in a finding")).toBe("finding");
});

test("shared context renders tasks, results, statuses and newest-first notes safely", () => {
  const board: Board = {
    statuses: { "shiro-1": "finished", "shiro-2": "running" },
    tasks: [
      { id: "t1", text: "inspect implementation", owner: "shiro-1", done: true, result: "checks passed" },
      { id: "t2", text: "independent review", owner: "shiro-2", done: false },
    ],
    notes: [
      { agent: "shiro-1", text: "old finding" },
      { agent: "shiro-2", text: "[failure] newer note <script>alert(1)</script>" },
      { agent: "shiro-1", text: "[type-gap] newest note" },
    ],
  };
  const html = renderToStaticMarkup(<ContextPage board={board} running title="test conversation" />);
  expect(html).toContain("共有文脈");
  expect(html).toContain("inspect implementation");
  expect(html).toContain("checks passed");
  expect(html).toContain("shiro-2");
  expect(html).toContain("作業中");
  expect(html).toContain("実行中・自動更新");
  expect(html.indexOf("newest note")).toBeLessThan(html.indexOf("newer note"));
  expect(html.indexOf("newer note")).toBeLessThan(html.indexOf("old finding"));
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("最新ターンのみ");
  expect(html).toContain("最大40件");
  expect(html).toContain("共有文脈をJSONでコピー");
});

test("empty and legacy conversations render without a board", () => {
  const html = renderToStaticMarkup(<ContextPage running={false} title="old conversation" />);
  expect(html).toContain("まだ共有タスクはありません。");
  expect(html).toContain("まだ共有ノートはありません。");
  expect(html).toContain("最新の保存内容");
});

test("four participants show distinct identities and startup waiting status", () => {
  const board: Board = {
    tasks: [], notes: [{ agent: "shiro-4", text: "integration notes" }],
    statuses: { "shiro-1": "running", "shiro-2": "waiting", "shiro-3": "waiting", "shiro-4": "waiting" },
  };
  const html = renderToStaticMarkup(<ContextPage board={board} running title="four peers" />);
  for (const peer of Object.keys(board.statuses!)) expect(html).toContain(peer);
  expect(html).toContain("開始待ち");
  expect(html).toContain("作業中");
  expect(html).toContain("peer-three");
  expect(html).toContain("peer-four");
  expect(html).toContain("integration notes");
});

test("the colony section shows proposals with their replay and cost, adopted types, reports and settled facts", async () => {
  const { ColonyView } = await import("./colony");
  const board: Board = { tasks: [], notes: [], gists: [{ agent: "shiro-2", type: "handoff", fields: { work: "run the suite" } }] };
  expect(renderToStaticMarkup(<ContextPage board={board} running title="t" />)).toContain("run the suite");
  const html = renderToStaticMarkup(<ColonyView decide={() => {}} data={{
    version: 3, threshold: 10, pending: 4, runs: [{ seq: 30, at: 0, reports: 12, proposals: 1 }],
    proposals: [{ seq: 29, at: 0, name: "handoff", purpose: "Remaining work offered to peers.", fields: { work: "what remains" }, obligation: "Claim it or leave it.", covers: [7], cost: { fields: 1, bytes: 120 } }],
    types: [],
    reports: [{ seq: 7, at: 0, conv: "abcdefgh1234", source: "observer", wanted: "hand the suite to a peer", distortion: "note text", cost: "unmeasured", evidence: ["#3"] }],
    settled: [{ seq: 5, at: 0, kind: "environment", text: "python3 is not installed", cwd: null, retracted: true }],
  }} />);
  for (const s of ["4 / 10", "#29 handoff", "対応する report 1 件", "欄 1・120 バイト", "#7 hand the suite to a peer", "観察者", "未計測", "打ち消し済み", "採用か却下を決める"]) expect(html).toContain(s);
});
