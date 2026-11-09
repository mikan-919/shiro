// Web search through Parallel (https://docs.parallel.ai/api-reference/search/search).
import type { Tool } from "./tools";

const API = process.env.SHIRO_PARALLEL_URL ?? "https://api.parallel.ai/v1/search";

type Result = { url: string; title?: string | null; publish_date?: string | null; excerpts?: string[] | null };

/** Markdown for both the model and the UI: a numbered list of linked titles with quoted excerpts. */
export function formatResults(results: Result[]): string {
  if (!results.length) return "No results.";
  return results
    .map((r, i) => {
      const title = (r.title || r.url).replace(/[[\]]/g, "");
      const date = r.publish_date ? ` (${r.publish_date})` : "";
      const text = (r.excerpts ?? []).join("\n…\n").trim();
      return `${i + 1}. [${title}](${r.url})${date}${text ? `\n${text.replace(/^/gm, "   > ")}` : ""}`;
    })
    .join("\n\n");
}

const queriesOf = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((q) => q.trim()) : []);

export const searchTool: Tool = {
  def: {
    type: "function",
    name: "web_search",
    description:
      "Search the web for current or external facts. Returns titles, URLs, publish dates and relevant excerpts. " +
      "Cite the URLs you rely on in your answer.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "What you want to find out, in one self-contained sentence." },
        search_queries: { type: "array", items: { type: "string" }, description: "2-3 keyword queries of 3-6 words each." },
      },
      required: ["objective", "search_queries"],
      additionalProperties: false,
    },
  },
  enabled: () => !!process.env.PARALLEL_API_KEY,
  view: (a) => ({
    label: "ウェブ検索",
    icon: "search",
    target: String(a.objective ?? ""),
    detail: { kind: "chips", items: queriesOf(a.search_queries) },
    markdown: true,
  }),
  run: async (a, { signal, model }) => {
    const res = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": process.env.PARALLEL_API_KEY ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: String(a.objective ?? ""),
        search_queries: queriesOf(a.search_queries).slice(0, 5),
        client_model: model,
        // Keeps one search from flooding the context window.
        max_chars_total: 12_000,
        advanced_settings: { max_results: 8 },
      }),
      signal: AbortSignal.any([AbortSignal.timeout(30_000), signal]),
    });
    if (!res.ok) throw new Error(`Parallel search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return formatResults(((await res.json()) as { results?: Result[] }).results ?? []);
  },
  summary: (_, out) => {
    if (out === undefined) return undefined;
    const titles = [...out.matchAll(/^\d+\. \[(.+?)\]/gm)].map((m) => m[1]!);
    if (!titles.length) return "結果なし";
    return titles.length > 1 ? `${titles[0]} ほか ${titles.length - 1} 件` : titles[0];
  },
};
