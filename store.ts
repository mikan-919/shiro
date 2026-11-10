import type { Board } from "./team";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ConvMeta, Effort, Message, Settings } from "./shared";

/** Shared transcript and latest board are persisted; each peer's tool/reasoning history is turn-local. */
export type Conv = { meta: ConvMeta; messages: Message[]; items: ResponseInputItem[]; board?: Board };

const path = process.env.SHIRO_DB ?? `${homedir()}/.shiro/shiro.db`;
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  messages TEXT NOT NULL, items TEXT NOT NULL, auto_approve INTEGER NOT NULL DEFAULT 1)`);
// Databases created before auto-approval existed lack the column. DEFAULT 1 fills their rows and matches
// DEFAULTS.autoApprove in shared.ts.
if (!db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().some((c) => c.name === "auto_approve"))
  db.run("ALTER TABLE conversations ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 1");

if (!db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().some((c) => c.name === "board"))
  db.run("ALTER TABLE conversations ADD COLUMN board TEXT");

type Row = { id: string; title: string; model: string; effort: Effort; created_at: number; updated_at: number; auto_approve: number };
const meta = (r: Row): ConvMeta => ({
  id: r.id, title: r.title, model: r.model, effort: r.effort, autoApprove: r.auto_approve === 1, createdAt: r.created_at, updatedAt: r.updated_at,
});

const cache = new Map<string, Conv>();

export function list(): ConvMeta[] {
  const rows = db.query<Row, []>("SELECT id, title, model, effort, auto_approve, created_at, updated_at FROM conversations ORDER BY updated_at DESC").all();
  return rows.map((r) => cache.get(r.id)?.meta ?? meta(r));
}

/** The same object is returned on every call, so changes to it are seen everywhere until save() persists them. */
export function get(id: string): Conv | undefined {
  const hit = cache.get(id);
  if (hit) return hit;
  const r = db.query<Row & { messages: string; items: string; board: string | null }, [string]>("SELECT * FROM conversations WHERE id = ?").get(id);
  if (!r) return;
  const conv = { meta: meta(r), messages: JSON.parse(r.messages), items: JSON.parse(r.items), board: r.board ? JSON.parse(r.board) : undefined };
  cache.set(id, conv);
  return conv;
}

export function create(m: Settings): Conv {
  const now = Date.now();
  const conv: Conv = { meta: { id: crypto.randomUUID(), title: "新しい会話", ...m, createdAt: now, updatedAt: now }, messages: [], items: [] };
  cache.set(conv.meta.id, conv);
  save(conv);
  return conv;
}

export function save(c: Conv) {
  const m = c.meta;
  db.query(
    `INSERT INTO conversations (id, title, model, effort, auto_approve, created_at, updated_at, messages, items, board)
     VALUES ($id, $title, $model, $effort, $auto, $created, $updated, $messages, $items, $board)
     ON CONFLICT(id) DO UPDATE SET title=$title, model=$model, effort=$effort, auto_approve=$auto, updated_at=$updated, messages=$messages, items=$items, board=$board`,
  ).run({
    id: m.id, title: m.title, model: m.model, effort: m.effort, auto: m.autoApprove ? 1 : 0, created: m.createdAt, updated: m.updatedAt,
    messages: JSON.stringify(c.messages), items: JSON.stringify(c.items), board: c.board ? JSON.stringify(c.board) : null,
  });
}

export function remove(id: string) {
  cache.delete(id);
  db.query("DELETE FROM conversations WHERE id = ?").run(id);
}
