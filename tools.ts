import type { FunctionTool } from "openai/resources/responses/responses";

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

export const TOOLS = [
  tool("read_file", "Read a text file.", { path: "File path" }),
  tool("write_file", "Create or overwrite a file.", { path: "File path", content: "Full file content" }),
  tool("edit_file", "Replace one exact, unique occurrence of old_str with new_str.", {
    path: "File path", old_str: "Exact text to replace", new_str: "Replacement text",
  }),
  tool("bash", "Run a shell command in the current directory. The user approves each call.", { command: "Command" }),
];

export async function runTool(name: string, a: Record<string, string>, confirm: (command: string) => Promise<boolean>) {
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
      if (!(await confirm(a.command!))) return "user denied this command";
      const r = await Bun.$`bash -c ${a.command!}`.nothrow().quiet();
      return `exit ${r.exitCode}\n${r.stdout}${r.stderr}`;
    }
  }
  throw new Error(`unknown tool ${name}`);
}
