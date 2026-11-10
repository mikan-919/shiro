import { expect, test } from "bun:test";
import { isPublicAddress, validateUrl, extractText } from "./fetch";

// All cases are deterministic and make no Internet requests.
test("web_fetch only accepts unauthenticated standard-port HTTP(S) URLs", () => {
  for (const input of ["https://example.com/path?q=1#fragment", "http://example.com/", "https://example.com:443/", "http://example.com:80/"])
    expect(validateUrl(input)).toBeInstanceOf(URL);
  for (const input of [
    "", "not a url", "file:///etc/passwd", "ftp://example.com/x", "data:text/plain,secret", "javascript:alert(1)",
    "https://user:password@example.com/", "http://example.com:3000/", "https://example.com:80/",
    "http://localhost/", "http://localhost./", "http://foo.localhost/", "http://127.0.0.1/", "http://127.1/",
    "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/",
  ]) expect(() => validateUrl(input), input).toThrow();
});

test("public address classification rejects private, special-use and transition addresses", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    expect(isPublicAddress(address), address).toBe(true);
  for (const address of [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "fc00::1", "fd00::1", "fe80::1", "ff02::1",
    "2001:db8::1", "2001::1", "2002:7f00:1::", "64:ff9b::7f00:1", "not-an-ip", "",
  ]) expect(isPublicAddress(address), address).toBe(false);
});

test("HTML extraction preserves readable text and entities without scripts and style", async () => {
  const page = await extractText(`<!doctype html><html><head><title>A &amp; B</title>
    <style>.secret { display: block }</style><script>stealSecrets()</script></head>
    <body><h1>Hello</h1><p>One &amp; two <strong>bold</strong>.</p><p>日本語の本文</p>
    <script>invisibleScript()</script><style>invisibleStyle()</style></body></html>`);
  expect(page.title).toBe("A & B");
  expect(page.text).toContain("Hello");
  expect(page.text).toContain("One & two");
  expect(page.text).toContain("日本語の本文");
  expect(page.text).not.toContain("stealSecrets");
  expect(page.text).not.toContain("invisibleScript");
  expect(page.text).not.toContain("invisibleStyle");
});

type Deps = NonNullable<Parameters<typeof fetchPage>[2]>;
type Request = NonNullable<Deps["request"]>;
type Reply = Awaited<ReturnType<Request>>;
const signal = () => new AbortController().signal;
const publicDNS: NonNullable<Deps["lookup"]> = async () => [{ address: "93.184.216.34", family: 4 }];
const bytes = (s: string) => new TextEncoder().encode(s);
function reply(text = "hello", headers: Reply["headers"] = { "content-type": "text/plain" }, status = 200) {
  let cancels = 0;
  return {
    response: { status, headers, body: (async function* () { yield bytes(text); })(), cancel() { cancels++; } },
    get cancels() { return cancels; },
  };
}

// Imported separately so the unit tests above stay easy to scan.
import { fetchPage } from "./fetch";

test("fetch validates every DNS result before passing a pinned public address to request", async () => {
  let requests = 0;
  const request: Request = async (_url, address) => {
    requests++;
    expect(address).toEqual({ address: "93.184.216.34", family: 4 });
    return reply().response;
  };
  const out = await fetchPage("https://example.com/path", signal(), { lookup: publicDNS, request });
  expect(out).toContain("hello");
  expect(out).toContain("https://example.com/path");
  expect(requests).toBe(1);
  for (const addresses of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]]) {
    await expect(fetchPage("https://example.com/", signal(), { lookup: async () => addresses, request })).rejects.toThrow();
  }
  expect(requests).toBe(1);
});

test("private redirects are blocked and each redirect response is cancelled", async () => {
  for (const location of ["http://127.0.0.1/secret", "http://localhost/", "file:///etc/passwd", "https://user:pass@example.com/"]) {
    const redirect = reply("", { location }, 302);
    let requests = 0;
    await expect(fetchPage("https://example.com/", signal(), { lookup: publicDNS, request: async () => { requests++; return redirect.response; } })).rejects.toThrow();
    expect(requests).toBe(1);
    expect(redirect.cancels).toBeGreaterThan(0);
  }
});

test("redirect DNS is rechecked and relative public redirects retain the final URL", async () => {
  const seen: string[] = [];
  let count = 0;
  const redirect = reply("", { location: "https://private.example/secret" }, 301);
  await expect(fetchPage("https://example.com/", signal(), {
    lookup: async (host) => host === "private.example" ? [{ address: "192.168.1.1", family: 4 }] : publicDNS(host),
    request: async () => { count++; return redirect.response; },
  })).rejects.toThrow();
  expect(count).toBe(1);
  const out = await fetchPage("https://example.com/start", signal(), {
    lookup: publicDNS,
    request: async (url) => {
      seen.push(url.href);
      return seen.length === 1 ? reply("", { location: "/final" }, 307).response : reply("finished").response;
    },
  });
  expect(seen).toEqual(["https://example.com/start", "https://example.com/final"]);
  expect(out).toContain("https://example.com/final");
  expect(out).toContain("finished");
});

test("redirect loops have a bounded number of network requests", async () => {
  let requests = 0;
  await expect(fetchPage("https://example.com/loop", signal(), { lookup: publicDNS, request: async () => { requests++; return reply("", { location: "/loop" }, 302).response; } })).rejects.toThrow();
  expect(requests).toBeLessThanOrEqual(6);
});

test("non-success, binary and encoded responses are rejected and cancelled", async () => {
  for (const [status, headers] of [
    [404, { "content-type": "text/plain" }], [200, { "content-type": "application/pdf" }],
    [200, { "content-type": "application/octet-stream" }], [200, { "content-type": "application/json" }],
    [200, { "content-type": "text/html", "content-encoding": "gzip" }],
  ] as [number, Reply["headers"]][]) {
    const r = reply("do not read", headers, status);
    await expect(fetchPage("https://example.com/", signal(), { lookup: publicDNS, request: async () => r.response })).rejects.toThrow();
    expect(r.cancels).toBeGreaterThan(0);
  }
});

test("both advertised and streamed oversized responses are rejected", async () => {
  const advertised = reply("small", { "content-type": "text/plain", "content-length": "2000001" });
  await expect(fetchPage("https://example.com/", signal(), { lookup: publicDNS, request: async () => advertised.response })).rejects.toThrow();
  expect(advertised.cancels).toBeGreaterThan(0);
  let cancelled = false;
  const huge: Reply = {
    status: 200, headers: { "content-type": "text/plain" },
    body: (async function* () { for (let i = 0; i < 3; i++) yield new Uint8Array(1_000_000); })(),
    cancel() { cancelled = true; },
  };
  await expect(fetchPage("https://example.com/", signal(), { lookup: publicDNS, request: async () => huge })).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("text output is bounded and HTML is converted rather than executed", async () => {
  const out = await fetchPage("https://example.com/", signal(), {
    lookup: publicDNS,
    request: async () => reply(`<title>Readable page</title><p>${"x".repeat(30_000)}</p><script>runBadCode()</script>`, { "content-type": "text/html; charset=utf-8" }).response,
  });
  expect(out).toContain("Readable page");
  expect(out).not.toContain("runBadCode");
  expect(out.length).toBeLessThan(21_000);
});

test("pre-aborted calls perform no DNS lookup or network request", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let lookups = 0;
  await expect(fetchPage("https://example.com/", ctl.signal, { lookup: async () => { lookups++; return []; } })).rejects.toThrow();
  expect(lookups).toBe(0);
});

test("a stalled DNS lookup is bounded by the overall timeout", async () => {
  const started = Date.now();
  const result = fetchPage("https://example.com/", signal(), { lookup: async () => new Promise(() => {}), timeoutMs: 15 });
  await expect(Promise.race([result, Bun.sleep(300).then(() => "hung")])).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(300);
});

test("abort during body streaming cancels the response", async () => {
  const ctl = new AbortController();
  let cancelled = false;
  const r: Reply = {
    status: 200, headers: { "content-type": "text/plain" },
    body: (async function* () {
      yield bytes("start");
      ctl.abort(new Error("user stopped"));
      yield bytes("must not finish");
    })(),
    cancel() { cancelled = true; },
  };
  await expect(fetchPage("https://example.com/", ctl.signal, { lookup: publicDNS, request: async () => r })).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("response bodies stalled between chunks are timed out and cancelled", async () => {
  let cancelled = false;
  const r: Reply = {
    status: 200, headers: { "content-type": "text/plain" },
    body: { [Symbol.asyncIterator]() { return { next: async () => new Promise<IteratorResult<Uint8Array>>(() => {}) }; } },
    cancel() { cancelled = true; },
  };
  await expect(Promise.race([
    fetchPage("https://example.com/", signal(), { lookup: publicDNS, request: async () => r, timeoutMs: 15 }),
    Bun.sleep(300).then(() => "hung"),
  ])).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("a response arriving after timeout is still cancelled", async () => {
  const r = reply("too late");
  await expect(fetchPage("https://example.com/", signal(), {
    lookup: publicDNS,
    request: async () => { await Bun.sleep(50); return r.response; },
    timeoutMs: 10,
  })).rejects.toThrow();
  await Bun.sleep(70);
  expect(r.cancels).toBeGreaterThan(0);
});

test("declared charset is used and numeric HTML entities decode", async () => {
  const r: Reply = { status: 200, headers: { "content-type": "text/plain; charset=windows-1252" },
    body: (async function* () { yield new Uint8Array([99, 97, 102, 233]); })(), cancel() {} };
  const out = await fetchPage("https://example.com/", signal(), { lookup: publicDNS, request: async () => r });
  expect(out).toContain("café");
  const html = await extractText("<p>&#x65e5;&#26412;&#35486; &lt;b&gt;not markup&lt;/b&gt;</p>");
  expect(html.text).toContain("日本語");
  expect(html.text).toContain("<b>not markup</b>");
});

test("web_fetch is registered without an API key and URLs need no shell approval", async () => {
  const { available, describe, usable } = await import("./tools");
  expect(available().some((t) => t.def.name === "web_fetch")).toBe(true);
  expect(usable("web_fetch")).toBeDefined();
  expect(describe("web_fetch", { url: "https://example.com/" })).toMatchObject({ label: "ページ取得", target: "https://example.com/", request: undefined });
});
