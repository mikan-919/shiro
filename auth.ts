// ChatGPT (Codex) OAuth. Endpoints and client id follow earendil-works/pi packages/ai/src/auth/oauth/openai-codex.ts.
import { homedir } from "node:os";
import { chmod } from "node:fs/promises";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const FILE = process.env.SHIRO_AUTH_FILE ?? `${homedir()}/.shiro/auth.json`;

export type Cred = { access: string; refresh: string; expires: number; accountId: string };

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export function accountIdOf(jwt: string): string {
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
  const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof id !== "string" || !id) throw new Error("chatgpt_account_id not found in token");
  return id;
}

async function token(params: Record<string, string>): Promise<Cred> {
  const res = await fetch(`${AUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!res.ok) throw new Error(`token ${params.grant_type} failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const cred = { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + j.expires_in * 1000, accountId: accountIdOf(j.access_token) };
  await Bun.write(FILE, JSON.stringify(cred));
  await chmod(FILE, 0o600);
  return cred;
}

async function login(): Promise<Cred> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(`${AUTH}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "openid profile email offline_access",
    code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "shiro",
  })) url.searchParams.set(k, v);

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // ponytail: port 1455 is shared with Codex CLI; add pasted-URL fallback or device-code login if it collides
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 1455,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
      const code = u.searchParams.get("code");
      if (u.searchParams.get("state") !== state || !code) {
        reject(new Error(`login failed: ${u.searchParams.get("error") ?? "state mismatch"}`));
        return new Response("login failed", { status: 400 });
      }
      resolve(code);
      return new Response("ログインしました。ターミナルに戻ってください。", { headers: { "content-type": "text/plain; charset=utf-8" } });
    },
  });
  console.log(`ブラウザで開いてログインしてください:\n${url}`);
  try {
    return await token({ grant_type: "authorization_code", code: await promise, code_verifier: verifier, redirect_uri: REDIRECT_URI });
  } finally {
    server.stop();
  }
}

export async function getCred(): Promise<Cred> {
  const f = Bun.file(FILE);
  if (!(await f.exists())) return login();
  const cred = (await f.json()) as Cred;
  if (cred.expires - Date.now() > 60_000) return cred;
  return token({ grant_type: "refresh_token", refresh_token: cred.refresh });
}
