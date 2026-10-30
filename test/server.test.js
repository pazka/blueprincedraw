import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliCompressSync } from "node:zlib";

import { CSP, createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createLogger } from "../server/log.js";
import { loadStatic } from "../server/static.js";

let dir;
let server;
let base;
const BUNDLE = "console.log('bundle');".repeat(100);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bpd-static-"));
  await mkdir(join(dir, "assets"));
  await mkdir(join(dir, "fonts", "Liberation"), { recursive: true });
  await writeFile(join(dir, "index.html"), '<!doctype html><script type="module" src="/assets/index-AbC123xY.js"></script>');
  await writeFile(join(dir, "assets", "index-AbC123xY.js"), BUNDLE);
  await writeFile(join(dir, "assets", "index-AbC123xY.js.br"), brotliCompressSync(BUNDLE));
  await writeFile(join(dir, "fonts", "Liberation", "LiberationSans-Regular.woff2"), "woff2");
  await writeFile(join(dir, "assets", "index-Ab-dE9_x.js"), "x"); // base64url hash with a dash
  await writeFile(join(dir, ".env"), "SECRET=1");
  await writeFile(join(dir, "notes.unknownext"), "x");

  const config = loadConfig({ APP_STATIC_DIR: dir, APP_VERSION: "test" });
  const app = createApp({ config, staticFiles: await loadStatic(dir), log: createLogger("error") });
  server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const get = (path, headers = {}) => fetch(base + path, { headers, redirect: "manual" });

test("healthz reports the front-end, not just a live process", async () => {
  const res = await get("/healthz");
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.index, true);
  assert.equal(body.fonts, 1);
  assert.equal(body.version, "test");
  const head = await fetch(`${base}/healthz`, { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("index.html: strict CSP, security headers, revalidated", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("content-security-policy"), CSP);
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.match(CSP, /connect-src 'self' data: blob:/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-cache");
});

test("hashed bundle: immutable, brotli when accepted, identity otherwise", async () => {
  const br = await get("/assets/index-AbC123xY.js", { "accept-encoding": "gzip, br" });
  assert.equal(br.status, 200);
  assert.equal(br.headers.get("content-encoding"), "br");
  assert.match(br.headers.get("cache-control"), /immutable/);
  assert.equal(await br.text(), BUNDLE); // fetch inflates it

  const plain = await get("/assets/index-AbC123xY.js", { "accept-encoding": "identity" });
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.equal(await plain.text(), BUNDLE);
  assert.notEqual(plain.headers.get("etag"), br.headers.get("etag"));
});

test("every vite asset is immutable, even when its hash contains a dash; unhashed fonts are not", async () => {
  const dashed = await get("/assets/index-Ab-dE9_x.js");
  assert.match(dashed.headers.get("cache-control"), /immutable/);
  const font = await get("/fonts/Liberation/LiberationSans-Regular.woff2");
  assert.doesNotMatch(font.headers.get("cache-control"), /immutable/);
  assert.equal((await get("/index.html")).headers.get("cache-control"), "no-cache");
});

test("conditional GET answers 304", async () => {
  const first = await get("/assets/index-AbC123xY.js", { "accept-encoding": "identity" });
  await first.arrayBuffer();
  const again = await get("/assets/index-AbC123xY.js", {
    "accept-encoding": "identity",
    "if-none-match": first.headers.get("etag"),
  });
  assert.equal(again.status, 304);
});

test("only files that were built are served: no dotfiles, traversal or listings", async () => {
  for (const path of [
    "/.env",
    "/notes.unknownext",
    "/assets/index-AbC123xY.js.br",
    "/assets/",
    "/fonts",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/assets/..%2f..%2findex.html",
    "/server/main.js",
  ]) {
    const res = await get(path);
    await res.arrayBuffer();
    assert.equal(res.status, 404, path);
  }
});

test("nothing can be written: every non-read method is refused", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await fetch(`${base}/`, { method, body: "x" });
    await res.arrayBuffer();
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  }
});

test("config rejects nonsense", () => {
  assert.throws(() => loadConfig({ APP_PORT: "abc" }), /APP_PORT/);
  assert.equal(loadConfig({}).port, 8000);
});
