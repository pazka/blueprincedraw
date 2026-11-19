// The logging standard (hosh-management AGENTS.md section 11), pinned so it cannot rot.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createApp, routeOf, SLOW_MS } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createLogger, errField } from "../server/log.js";
import { loadStatic } from "../server/static.js";

const MAIN = fileURLToPath(new URL("../server/main.js", import.meta.url));
const SECRET_PATH = "/assets/gone-QQQQ1111.js";
const SECRET_QUERY = "token=SECRETQUERY";
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bpd-log-"));
  await mkdir(join(dir, "assets"));
  await mkdir(join(dir, "fonts"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(dir, "assets", "index-AbC123xY.js"), "x");
  await writeFile(join(dir, "assets", "gone-QQQQ1111.js"), "x");
  await writeFile(join(dir, "fonts", "a.woff2"), "x");
});
after(() => rm(dir, { recursive: true, force: true }));

/** Captures lines at `level`; returns { lines, get(path, init), close }. */
async function start({ level = "info", staticFiles, now } = {}) {
  const lines = [];
  const out = { write: (s) => lines.push(...s.trim().split("\n").map((l) => JSON.parse(l))) };
  const config = loadConfig({ APP_STATIC_DIR: dir, APP_VERSION: "v9.9.9" });
  const log = createLogger(level, out, { version: config.version });
  const server = createServer(createApp({ config, staticFiles: staticFiles ?? (await loadStatic(dir)), log, now }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, init = {}) => {
    const res = await fetch(base + path, { redirect: "manual", ...init }).catch((e) => ({ error: e }));
    if (res.arrayBuffer) await res.arrayBuffer().catch(() => {});
    await new Promise((r) => setTimeout(r, 30)); // the "close" line is written just after the answer
    return res;
  };
  return { lines, get, close: () => new Promise((r) => server.close(r)) };
}

function checkFormat(line) {
  assert.match(line.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(["debug", "info", "warn", "error"].includes(line.level));
  assert.equal(line.service, "blueprincedraw");
  assert.equal(typeof line.version, "string");
  assert.match(line.event, /^[a-z][a-z0-9_]*$/);
  assert.equal(typeof line.msg, "string");
}

test("log: every line has ts, level, service, version, event, msg; levels filter", () => {
  const lines = [];
  const log = createLogger("warn", { write: (s) => lines.push(JSON.parse(s)) }, { version: "v1.2.3" });
  log.info("ignored", "below warn");
  log.warn("thing_happened", "a thing", { n: 1 });
  assert.equal(lines.length, 1);
  checkFormat(lines[0]);
  assert.equal(lines[0].version, "v1.2.3");
  assert.equal(lines[0].event, "thing_happened");
  assert.equal(lines[0].n, 1);
  assert.equal(lines[0].t, undefined);
  // an unknown level means info
  const l2 = [];
  const info = createLogger("loud", { write: (s) => l2.push(s) });
  info.debug("x", "x");
  info.info("y", "y");
  assert.equal(l2.length, 1);
  assert.equal(loadConfig({}).logLevel, "info");
  assert.equal(loadConfig({ LOG_LEVEL: "debug" }).logLevel, "debug");
  assert.equal(loadConfig({ LOG_LEVEL: "debug", APP_LOG_LEVEL: "warn" }).logLevel, "warn");
});

test("log: x-request-id is echoed when it is a token, generated otherwise, on every answer", async () => {
  const s = await start();
  try {
    const cases = [
      ["/", "GET", 200],
      ["/healthz", "GET", 200],
      ["/nope", "GET", 404],
      ["/", "POST", 405],
    ];
    for (const [path, method, status] of cases) {
      const echoed = await s.get(path, { method, headers: { "x-request-id": "edge-abc.123" } });
      assert.equal(echoed.status, status, path);
      assert.equal(echoed.headers.get("x-request-id"), "edge-abc.123", `${method} ${path}`);
      const made = await s.get(path, { method, headers: { "x-request-id": "bad id <script>" } });
      assert.match(made.headers.get("x-request-id"), /^[0-9a-f-]{36}$/, `${method} ${path}`);
      const none = await s.get(path, { method });
      assert.match(none.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
    }
    assert.deepEqual(s.lines, [], "plain 2xx/4xx answers write nothing at info");
  } finally {
    await s.close();
  }
});

test("log: route is a template, never the raw path", async () => {
  const files = await loadStatic(dir);
  assert.equal(routeOf("/healthz", files), "/healthz");
  assert.equal(routeOf("/", files), "/");
  assert.equal(routeOf("/index.html", files), "/");
  assert.equal(routeOf("/assets/index-AbC123xY.js", files), "/assets/*");
  assert.equal(routeOf("/fonts/a.woff2", files), "/fonts/*");
  assert.equal(routeOf("/secret/room-id", files), "(not found)");
  assert.equal(routeOf(undefined, files), "(invalid)");
  const s = await start({ level: "debug" });
  try {
    await s.get(`/assets/index-AbC123xY.js?${SECRET_QUERY}`, { headers: { "x-request-id": "r1" } });
    await s.get(`/private-thing?${SECRET_QUERY}`);
    const http = s.lines.filter((l) => l.event === "http");
    assert.equal(http.length, 2);
    assert.deepEqual(
      http.map((l) => [l.level, l.route, l.status]),
      [
        ["debug", "/assets/*", 200],
        ["debug", "(not found)", 404],
      ],
    );
    assert.equal(http[0].req_id, "r1");
    assert.equal(http[0].method, "GET");
    assert.equal(typeof http[0].dur_ms, "number");
    for (const l of s.lines) checkFormat(l);
    const raw = JSON.stringify(s.lines);
    assert.ok(!raw.includes("SECRETQUERY") && !raw.includes("private-thing") && !raw.includes("index-AbC123xY"), raw);
  } finally {
    await s.close();
  }
});

test("log: a 5xx writes one error line with req_id, route, status and err; the raw URL is hidden", async () => {
  const files = await loadStatic(dir);
  const broken = new Map(files);
  // a real request through the real handler: the static lookup throws, naming the raw request URL
  broken.get = (key) => {
    throw new TypeError(`lookup failed for ${key}?${SECRET_QUERY}`);
  };
  const s = await start({ staticFiles: broken });
  try {
    const res = await s.get(`/fonts/a.woff2?${SECRET_QUERY}`, { headers: { "x-request-id": "qa-500" } });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-request-id"), "qa-500");
    assert.equal(s.lines.length, 1, JSON.stringify(s.lines));
    const [l] = s.lines;
    checkFormat(l);
    assert.equal(l.level, "error");
    assert.equal(l.event, "request_failed");
    assert.equal(l.req_id, "qa-500");
    assert.equal(l.method, "GET");
    assert.equal(l.route, "/fonts/*");
    assert.equal(l.status, 500);
    assert.equal(typeof l.dur_ms, "number");
    assert.equal(l.err.type, "TypeError");
    assert.match(l.err.message, /lookup failed for <hidden>/);
    assert.match(l.err.stack, /TypeError/);
    const raw = JSON.stringify(l);
    assert.ok(!raw.includes("SECRETQUERY") && !raw.includes("a.woff2"), raw);
  } finally {
    await s.close();
  }
});

test("log: a built file that cannot be read writes static_read_failed with err, and the answer is cut", async () => {
  const s = await start({ level: "debug", staticFiles: await loadStatic(dir) });
  try {
    await unlink(join(dir, "assets", "gone-QQQQ1111.js")); // listed at startup, gone from disk now
    const res = await s.get(`${SECRET_PATH}?${SECRET_QUERY}`, { headers: { "x-request-id": "qa-read" } });
    assert.ok(res.error || res.status === 200, "the headers may already be out");
    await new Promise((r) => setTimeout(r, 50));
    const fail = s.lines.filter((l) => l.event === "static_read_failed");
    assert.equal(fail.length, 1, JSON.stringify(s.lines));
    checkFormat(fail[0]);
    assert.equal(fail[0].level, "error");
    assert.equal(fail[0].req_id, "qa-read");
    assert.equal(fail[0].route, "/assets/*");
    assert.equal(fail[0].err.type, "Error");
    assert.match(fail[0].err.message, /ENOENT/);
    const cut = s.lines.filter((l) => l.event === "http");
    assert.equal(cut.length, 1, JSON.stringify(s.lines));
    assert.deepEqual([cut[0].req_id, cut[0].aborted], ["qa-read", true]);
    assert.ok(!JSON.stringify(s.lines).includes("SECRETQUERY"));
    assert.ok(!JSON.stringify(s.lines).includes("QQQQ1111"));
  } finally {
    await s.close();
  }
});

test("log: an answer slower than 1 s writes one warn line", async () => {
  let t = 0;
  const now = () => (t += SLOW_MS + 1); // the end is read SLOW_MS + 1 ms after the start
  const s = await start({ now });
  try {
    await s.get(`/?${SECRET_QUERY}`, { headers: { "x-request-id": "qa-slow" } });
    assert.equal(s.lines.length, 1, JSON.stringify(s.lines));
    const [l] = s.lines;
    checkFormat(l);
    assert.deepEqual([l.level, l.event, l.msg, l.req_id, l.route, l.status], ["warn", "http", "slow request", "qa-slow", "/", 200]);
    assert.ok(l.dur_ms > SLOW_MS);
    assert.equal(l.err, undefined);
    assert.ok(!JSON.stringify(l).includes("SECRETQUERY"));
  } finally {
    await s.close();
  }
});

test("log: /healthz is logged at debug only, even slow or failing", async () => {
  const files = await loadStatic(dir);
  const broken = new Map(files);
  broken.has = () => {
    throw new Error("disk gone");
  };
  let t = 0;
  for (const [staticFiles, status] of [
    [files, 200],
    [broken, 500],
  ]) {
    for (const level of ["info", "debug"]) {
      const s = await start({ level, staticFiles, now: () => (t += SLOW_MS) });
      try {
        const res = await s.get("/healthz", { headers: { "x-request-id": "qa-hz" } });
        assert.equal(res.status, status);
        if (level === "info") assert.deepEqual(s.lines, [], `healthz ${status} at info`);
        else {
          assert.equal(s.lines.length, 1, JSON.stringify(s.lines));
          const [l] = s.lines;
          checkFormat(l);
          assert.deepEqual([l.level, l.route, l.status, l.req_id], ["debug", "/healthz", status, "qa-hz"]);
          assert.equal(l.event, status === 500 ? "request_failed" : "http");
          if (status === 500) assert.equal(l.err.message, "disk gone");
          else assert.equal(l.err, undefined);
        }
      } finally {
        await s.close();
      }
    }
  }
});

test("log: errField gives type, message and stack and hides what it is told to", () => {
  const e = new RangeError("bad /r/abc?x=1");
  const { err } = errField(e, ["/r/abc?x=1"]);
  assert.equal(err.type, "RangeError");
  assert.equal(err.message, "bad <hidden>");
  assert.ok(!err.stack.includes("/r/abc"));
  assert.deepEqual(errField("plain"), { err: { type: "string", message: "plain" } });
});

async function freePort() {
  const srv = netServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test("log: the real server writes one startup line (config names, no values) and one shutdown line", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, APP_PORT: String(port), APP_HOST: "127.0.0.1", APP_STATIC_DIR: dir, APP_VERSION: "v7.7.7" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const lines = () => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (let i = 0; i < 100 && !out.includes('"startup"'); i++) await new Promise((r) => setTimeout(r, 50));
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  const all = lines();
  for (const l of all) checkFormat(l);
  assert.deepEqual(all.map((l) => l.event), ["startup", "shutdown"]);
  const [st, sd] = all;
  assert.equal(st.level, "info");
  assert.equal(st.version, "v7.7.7");
  assert.equal(st.port, port);
  assert.equal(st.data_dir, "none");
  assert.equal(st.log_level, "info");
  assert.deepEqual(st.config, ["APP_PORT", "APP_HOST", "APP_STATIC_DIR", "APP_VERSION"]);
  assert.ok(!JSON.stringify(st).includes(dir), "config values are never logged");
  assert.equal(sd.signal, "SIGTERM");
  assert.equal(typeof sd.uptime_s, "number");
});

test("log: a server that cannot load its front-end writes one startup_failed error line and exits 1", async () => {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, APP_PORT: String(await freePort()), APP_STATIC_DIR: join(dir, "missing") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 1);
  const all = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(all.length, 1);
  checkFormat(all[0]);
  assert.deepEqual([all[0].level, all[0].event], ["error", "startup_failed"]);
  assert.equal(all[0].err.type, "Error");
});
