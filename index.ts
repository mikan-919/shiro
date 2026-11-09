import OpenAI from "openai";
import type { ResponseInputItem, ResponseFunctionToolCall, FunctionTool } from "openai/resources/responses/responses";
import { createInterface } from "node:readline/promises";
import { getCred } from "./auth";

const MODEL = process.env.SHIRO_MODEL ?? "gpt-6.1-sol";

const tool = (name: string, description: string, props: Record<string, string>): FunctionTool => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: {
    type: "object",
    properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: "string", description: d }])),
    required: Object.keys(props),
    additionalProperties: false,
  },
});

const TOOLS = [
  tool("read_file", "Read a text file.", { path: "File path" }),
  tool("write_file", "Create or overwrite a file.", { path: "File path", content: "Full file content" }),
  tool("edit_file", "Replace one exact, unique occurrence of old_str with new_str.", {
    path: "File path", old_str: "Exact text to replace", new_str: "Replacement text",
  }),
  tool("bash", "Run a shell command in the current directory. The user approves each call.", { command: "Command" }),
];

export async function runTool(name: string, a: Record<string, string>, confirm: (q: string) => Promise<boolean>) {
  switch (name) {
    case "read_file":
      return await Bun.file(a.path!).text();
    case "write_file":
      await Bun.write(a.path!, a.content!);
      return `wrote ${a.path}`;
    case "edit_file": {
      const text = await Bun.file(a.path!).text();
      const n = text.split(a.old_str!).length - 1;
      if (n !== 1) throw new Error(`old_str matched ${n} times, need exactly 1`);
      await Bun.write(a.path!, text.replace(a.old_str!, () => a.new_str!));
      return `edited ${a.path}`;
    }
    case "bash": {
      if (!(await confirm(`$ ${a.command}`))) return "user denied this command";
      const r = await Bun.$`bash -c ${a.command!}`.nothrow().quiet();
      return `exit ${r.exitCode}\n${r.stdout}${r.stderr}`;
    }
  }
  throw new Error(`unknown tool ${name}`);
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = async (q: string) => (await rl.question(`${q}\n実行しますか? [y/N] `)).trim().toLowerCase() === "y";
  await getCred(); // log in before the first prompt
  const session = crypto.randomUUID();
  const instructions = `You are a coding agent working in ${process.cwd()}. Use the tools to inspect and change files. Be concise.`;
  const input: ResponseInputItem[] = []; // ponytail: full history resent each turn, add compaction when context fills up

  while (true) {
    const line = await rl.question("\n> ");
    if (line === "/exit") break;
    input.push({ role: "user", content: line });

    while (true) {
      const { access, accountId } = await getCred();
      const client = new OpenAI({
        apiKey: access,
        baseURL: "https://chatgpt.com/backend-api/codex",
        defaultHeaders: { "chatgpt-account-id": accountId, "OpenAI-Beta": "responses=experimental", originator: "shiro", "session-id": session },
      });
      const stream = await client.responses.create({
        model: MODEL, instructions, input, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: true,
        store: false, stream: true, include: ["reasoning.encrypted_content"], prompt_cache_key: session,
      });
      const calls: ResponseFunctionToolCall[] = [];
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") process.stdout.write(ev.delta);
        else if (ev.type === "response.output_item.done") {
          input.push(ev.item as ResponseInputItem);
          if (ev.item.type === "function_call") calls.push(ev.item);
        } else if (ev.type === "response.failed") throw new Error(ev.response.error?.message ?? "response failed");
      }
      process.stdout.write("\n");
      if (!calls.length) break;

      for (const c of calls) {
        console.log(`[${c.name}] ${c.arguments.slice(0, 200)}`);
        let output: string;
        try {
          output = String(await runTool(c.name, JSON.parse(c.arguments), confirm));
        } catch (e) {
          output = `error: ${(e as Error).message}`;
        }
        input.push({ type: "function_call_output", call_id: c.call_id, output });
      }
    }
  }
  rl.close();
}

if (import.meta.main) await main();
