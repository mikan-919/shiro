// Talking to the user as in a messaging app: the agent sends bubbles and reacts to messages through tools.
import { def, str, type Tool } from "./toolkit";

export const sendMessage: Tool = {
  def: def(
    "send_message",
    "Send a chat message to the user. This is the only way the user sees anything you write. " +
      "Write like texting: short messages, several in a row for a longer reply. Markdown works.",
    { text: "The message" },
  ),
  silent: true,
  view: (a) => ({ label: "メッセージ", icon: "chat", target: str(a.text) }),
  run: async (a, { chat }) => {
    const text = str(a.text).trim();
    if (!text) throw new Error("text is empty");
    chat.say(text);
    return "sent";
  },
};

export const react: Tool = {
  def: def(
    "react",
    "React to one of the user's messages with an emoji, as in a messaging app. Use it when it feels natural, not on every message.",
    { message_id: "The id at the start of the user's message, e.g. 1a2b3c4d from [#1a2b3c4d]", emoji: "One emoji" },
  ),
  silent: true,
  view: (a) => ({ label: "リアクション", icon: "chat", target: str(a.emoji) }),
  run: async (a, { chat }) => {
    const emoji = str(a.emoji).trim();
    if (!emoji || [...emoji].length > 4) throw new Error("emoji must be a single emoji");
    if (!chat.react(str(a.message_id).replace(/[[\]#\s]/g, ""), emoji)) throw new Error("no user message has that id");
    return "reacted";
  },
};
