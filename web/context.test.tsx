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
