/**
 * Capability smoke (DEPLOY.md §3), run INSIDE the container after every deploy
 * (hosh-deploy POST_DEPLOY; non-zero exit = automatic rollback) and in CI:
 *
 *   node /app/server/smoke.js http://127.0.0.1:8000
 *
 * Proves the editor can actually load, not just that something answers: the
 * page with its strict CSP, its scripts (precompressed, immutable), the
 * Excalidraw fonts and locales served locally, and that the server accepts
 * nothing but reads. One JSON line per check.
 */

const base = (process.argv[2] || `http://127.0.0.1:${process.env.APP_PORT || 8000}`).replace(/\/$/, "");
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(JSON.stringify({ check: name, ok: true, ...(detail ? { detail } : {}) }));
  } catch (err) {
    failed += 1;
    console.log(JSON.stringify({ check: name, ok: false, detail: err?.message || String(err) }));
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const get = async (path, headers = {}) => {
  const res = await fetch(base + path, { redirect: "manual", headers });
  const body = Buffer.from(await res.arrayBuffer());
  return { res, body, text: body.toString("utf8") };
};

await check("healthz", async () => {
  const { res, text } = await get("/healthz");
  const body = JSON.parse(text);
  expect(res.status === 200 && body.status === "ok" && body.index === true, `${res.status} ${text}`);
  return `files=${body.files} version=${body.version}`;
});

let html = "";
await check("page + strict CSP", async () => {
  const r = await get("/");
  html = r.text;
  const csp = r.res.headers.get("content-security-policy") || "";
  expect(r.res.status === 200 && /text\/html/.test(r.res.headers.get("content-type")), `status ${r.res.status}`);
  for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
    expect(csp.includes(d), `CSP lacks ${d}: ${csp}`);
  }
  expect(r.res.headers.get("x-content-type-options") === "nosniff", "nosniff missing");
  expect(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "inline script in index.html");
  expect(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, "")), "absolute URL in index.html (CDN?)");
});

await check("app bundle (immutable, brotli)", async () => {
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(js, "no /assets/*.js in index.html");
  const { res, body } = await get(js, { "accept-encoding": "br" });
  expect(res.status === 200 && body.length > 1000, `status ${res.status}`);
  expect(/immutable/.test(res.headers.get("cache-control") || ""), "bundle not immutable");
  expect(res.headers.get("content-encoding") === "br", `encoding ${res.headers.get("content-encoding")}`);
  return js;
});

await check("excalidraw fonts + locales served locally", async () => {
  const h = JSON.parse((await get("/healthz")).text);
  expect(h.fonts > 50 && h.locales > 20, `fonts=${h.fonts} locales=${h.locales}`);
  const { res, body } = await get("/fonts/Liberation/LiberationSans-Regular.woff2");
  expect(res.status === 200 && res.headers.get("content-type") === "font/woff2" && body.length > 10_000, `font -> ${res.status}`);
  const dir = await get("/fonts/");
  expect(dir.res.status === 404, `directory listing -> ${dir.res.status}`);
  return `fonts=${h.fonts} locales=${h.locales}`;
});

await check("dotfiles and sources 404", async () => {
  for (const p of ["/.env", "/.git/config", "/server/main.js", "/package.json", "/../etc/passwd"]) {
    const { res } = await get(p);
    expect(res.status === 404, `${p} -> ${res.status}`);
  }
});

await check("read-only server", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await fetch(`${base}/`, { method, body: method === "DELETE" ? undefined : "x" });
    await res.arrayBuffer();
    expect(res.status === 405, `${method} / -> ${res.status}`);
  }
});

console.log(JSON.stringify({ summary: failed ? "FAIL" : "PASS", failed }));
process.exitCode = failed ? 1 : 0;
