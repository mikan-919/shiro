// One model response from the ChatGPT Codex backend (the Responses API, authenticated with ChatGPT OAuth).
import OpenAI from "openai";
import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import { getCred } from "./auth";
import type { Effort } from "./shared";

const BASE_URL = process.env.SHIRO_CODEX_URL ?? "https://chatgpt.com/backend-api/codex";

export type CodexEvent =
  | { type: "reasoning"; text: string }
  | { type: "reasoning_end" }
  | { type: "text"; text: string }
  /** A finished output item, to append to the conversation history as is. */
  | { type: "item"; item: ResponseInputItem };

export async function* respond(o: {
  model: string;
  effort: Effort;
  instructions: string;
  input: ResponseInputItem[];
  tools: FunctionTool[];
  session: string;
  signal: AbortSignal;
}): AsyncGenerator<CodexEvent> {
  const { access, accountId } = await getCred();
  const client = new OpenAI({
    apiKey: access,
    baseURL: BASE_URL,
    defaultHeaders: { "chatgpt-account-id": accountId, "OpenAI-Beta": "responses=experimental", originator: "shiro", "session-id": o.session },
  });
  const stream = await client.responses.create(
    {
      model: o.model, instructions: o.instructions, input: o.input,
      // The observer calls without tools; an empty tool list is left out rather than sent.
      ...(o.tools.length ? { tools: o.tools, tool_choice: "auto" as const, parallel_tool_calls: true } : {}),
      reasoning: { effort: o.effort, summary: "auto" },
      // The Codex backend rejects store: true; encrypted reasoning keeps the chain of thought across requests instead.
      store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: o.session,
    },
    { signal: o.signal },
  );
  for await (const ev of stream) {
    if (ev.type === "response.reasoning_summary_text.delta") yield { type: "reasoning", text: ev.delta };
    else if (ev.type === "response.reasoning_summary_part.done") yield { type: "reasoning", text: "\n\n" };
    else if (ev.type === "response.output_text.delta") yield { type: "text", text: ev.delta };
    else if (ev.type === "response.output_item.done") {
      if (ev.item.type === "reasoning") yield { type: "reasoning_end" };
      yield { type: "item", item: ev.item as ResponseInputItem };
    } else if (ev.type === "response.failed") throw new Error(ev.response.error?.message ?? "応答の生成に失敗しました");
  }
}
