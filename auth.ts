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

/** Starts a callback server on :1455 and returns the URL to open. After login the browser is sent to returnTo. */
export function startLogin(returnTo: string): { url: string; done: Promise<Cred> } {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Bun.CryptoHasher("sha256").update(verifier).digest());
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(`${AUTH}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "openid profile email offline_access",
    code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "shiro",
  })) url.searchParams.set(k, v);

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => reject(new Error("login timed out")), 10 * 60_000);
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
      return Response.redirect(returnTo, 302);
    },
  });
  const done = promise
    .then((code) => token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI }))
    .finally(() => (clearTimeout(timer), server.stop()));
  return { url: url.toString(), done };
}

export const hasCred = () => Bun.file(FILE).exists();
export const logout = () => Bun.file(FILE).delete().catch(() => {});

/** Email and plan for display. The access token carries them as claims; missing claims are fine. */
export async function account(): Promise<{ email?: string; plan?: string }> {
  try {
    const { access } = await getCred();
    const p = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
    return { email: p?.["https://api.openai.com/profile"]?.email, plan: p?.["https://api.openai.com/auth"]?.chatgpt_plan_type };
  } catch {
    return {};
  }
}

export async function getCred(): Promise<Cred> {
  const f = Bun.file(FILE);
  if (!(await f.exists())) throw new Error("not logged in");
  const cred = (await f.json()) as Cred;
  if (cred.expires - Date.now() > 60_000) return cred;
  return token({ grant_type: "refresh_token", refresh_token: cred.refresh });
}
