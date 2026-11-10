import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Thread } from "./thread";
import type { Conversation } from "./sync";

const noop = () => {};
test("group chat keeps bubble order, names speakers and shows pending participant", () => {
  const conv: Conversation = {
    meta: { id: "c", title: "test", model: "test", effort: "medium", autoApprove: false, createdAt: 0, updatedAt: 0, running: true },
    messages: [
      { id: "work", role: "assistant", agent: "shiro-2", model: "test", status: "streaming", parts: [{ type: "tool", id: "approval", name: "bash", args: "{}", view: { label: "コマンド", icon: "terminal", target: "pwd", request: "pwd" }, status: "awaiting" }] },
      { id: "a", role: "assistant", agent: "shiro-1", model: "test", status: "done", parts: [{ type: "say", id: "say-a", text: "first bubble" }] },
      { id: "b", role: "assistant", agent: "shiro-2", model: "test", status: "done", parts: [{ type: "say", id: "say-b", text: "second bubble" }] },
      { id: "c", role: "assistant", agent: "shiro-1", model: "test", status: "done", parts: [{ type: "say", id: "say-c", text: "third bubble" }] },
    ],
  };
  const html = renderToStaticMarkup(<Thread conv={conv} known={new Set()} onApprove={noop} onReact={noop} onEdit={noop} onRegenerate={noop} onImage={noop} />);
  expect(html).toContain("shiro-1");
  expect(html).toContain("shiro-2");
  expect(html).toContain("peer-two");
  expect(html.indexOf("first bubble")).toBeLessThan(html.indexOf("second bubble"));
  expect(html.indexOf("second bubble")).toBeLessThan(html.indexOf("third bubble"));
  expect(html).toContain("承認待ち");
  expect(html).toContain("このコマンドを実行しますか？");
  expect(html).toContain('aria-label="参加者の状態"');
});

test("four-peer chat renders each speaker color and active typing state", () => {
  const peers = ["shiro-1", "shiro-2", "shiro-3", "shiro-4"];
  const conv: Conversation = {
    meta: { id: "four", title: "four peers", model: "test", effort: "medium", autoApprove: false, createdAt: 0, updatedAt: 0, running: true },
    messages: peers.map((agent) => ({ id: agent, agent, role: "assistant", model: "test", status: "streaming", parts: [{ type: "say", id: `${agent}-say`, text: `${agent} report` }] })),
  };
  const html = renderToStaticMarkup(<Thread conv={conv} known={new Set()} onApprove={noop} onReact={noop} onEdit={noop} onRegenerate={noop} onImage={noop} />);
  for (const peer of peers) expect(html).toContain(`${peer} report`);
  expect(html).toContain("peer-three");
  expect(html).toContain("peer-four");
  expect(html.match(/aria-label="入力中"/g)).toHaveLength(4);
});
