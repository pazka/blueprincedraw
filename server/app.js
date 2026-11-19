/**
 * HTTP surface of BlueprinceDraw: the built front-end and /healthz. Nothing
 * else. Boards are stored only in the visitor's browser (IndexedDB) or in a
 * local folder they pick; no request ever carries a board to this server.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { errField } from "./log.js";
import { serveStatic } from "./static.js";

/** A request slower than this is logged at warn (AGENTS.md section 11). */
export const SLOW_MS = 1000;

/** The edge's X-Request-Id when it is a plain token, else a new one. */
export function requestId(header) {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : randomUUID();
}

/** The route template of a path: never the raw path or its query string. */
export function routeOf(pathname, staticFiles) {
  if (pathname === undefined) return "(invalid)";
  if (pathname === "/healthz") return "/healthz";
  if (pathname === "/" || pathname === "/index.html") return "/";
  if (!staticFiles.has(pathname)) return "(not found)";
  const top = /^\/(assets|fonts|locales)\//.exec(pathname);
  return top ? `/${top[1]}/*` : "/:file";
}

/** Everything is same-origin: no CDN, no third-party script, no framing.
 *  connect-src 'self' also means the page cannot send a board anywhere else.
 *  Inline styles stay allowed because the Excalidraw editor sets them at runtime. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

function json(res, status, body, method = "GET") {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : data);
}

export function createApp({ config, staticFiles, log, now = () => performance.now() }) {
  return function handle(req, res) {
    const start = now();
    const reqId = requestId(req.headers["x-request-id"]);
    res.setHeader("X-Request-Id", reqId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    let pathname;
    try {
      pathname = new URL(req.url, "http://local").pathname;
    } catch {
      pathname = undefined;
    }
    let route = "(invalid)";
    let failure = null;
    // Requests are not logged at info (Traefik has them): only a 5xx, a slow answer, and /healthz never
    // above debug, whatever its status (the container healthcheck calls it every 30 s).
    // "close" also fires when an answer is cut short (res.destroy()), which "finish" never sees.
    res.on("close", () => {
      const durMs = Math.round(now() - start);
      const fields = { req_id: reqId, method: req.method, route, status: res.statusCode, dur_ms: durMs };
      if (!res.writableFinished) fields.aborted = true;
      const extra = failure ? errField(failure, [req.url, pathname]) : {};
      const event = failure ? "request_failed" : "http";
      if (route === "/healthz") log.debug(event, "healthz", { ...fields, ...extra });
      else if (res.statusCode >= 500) log.error(event, "server error", { ...fields, ...extra });
      else if (durMs > SLOW_MS) log.warn("http", "slow request", fields);
      else log.debug("http", "request", fields);
    });

    try {
      route = routeOf(pathname, staticFiles);
    } catch (err) {
      failure = err;
      return json(res, 500, { error: "internal" }, req.method);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return json(res, 405, { error: "method_not_allowed" });
    }
    if (pathname === undefined) return json(res, 400, { error: "bad_url" });
    try {
      if (pathname === "/healthz") {
        // proves the front-end is actually there to serve, not just that the process is up
        return json(
          res,
          200,
          {
            status: "ok",
            version: config.version,
            files: staticFiles.size,
            index: staticFiles.has("/index.html"),
            fonts: [...staticFiles.keys()].filter((k) => k.startsWith("/fonts/")).length,
            locales: [...staticFiles.keys()].filter((k) => k.startsWith("/locales/")).length,
            uptime_s: Math.round(process.uptime()),
          },
          req.method,
        );
      }
      const onReadError = (err) =>
        log.error("static_read_failed", "a built file could not be read", {
          req_id: reqId,
          method: req.method,
          route,
          ...errField(err, [req.url, pathname]),
        });
      if (!serveStatic(staticFiles, req, res, pathname, onReadError)) json(res, 404, { error: "not_found" }, req.method);
    } catch (err) {
      failure = err;
      if (!res.headersSent) json(res, 500, { error: "internal" }, req.method);
      else res.destroy();
    }
  };
}
