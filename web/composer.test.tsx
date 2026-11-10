import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "./composer";

function render(running: boolean, value = "追記です", disabled = false) {
  return renderToStaticMarkup(<Composer value={value} onChange={() => {}} running={running} disabled={disabled} onSend={async () => true} onStop={() => {}} placeholder="メッセージ" />);
}

function sendDisabled(html: string) {
  return /<button\b[^>]*disabled=""[^>]*aria-label="送信"/.test(html);
}

test("running composer allows follow-up send and keeps a separate stop button", () => {
  const html = render(true);
  expect(html).toContain('type="submit"');
  expect(html).toContain('aria-label="送信"');
  expect(sendDisabled(html)).toBe(false);
  expect(html).toContain('type="button" class="send stop"');
  expect(html).toContain('aria-label="生成を停止"');
  expect(html).not.toContain('<textarea disabled=""');
});

test("idle composer sends normally without a stop button", () => {
  const html = render(false);
  expect(sendDisabled(html)).toBe(false);
  expect(html).not.toContain('aria-label="生成を停止"');
});

test("empty or unauthenticated composers cannot send even while running", () => {
  expect(sendDisabled(render(true, "   "))).toBe(true);
  expect(sendDisabled(render(true, "追記です", true))).toBe(true);
});
