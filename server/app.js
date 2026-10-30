/**
 * HTTP surface of BlueprinceDraw: the built front-end and /healthz. Nothing
 * else. Boards are stored only in the visitor's browser (IndexedDB) or in a
 * local folder they pick; no request ever carries a board to this server.
 */

import { serveStatic } from "./static.js";

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

export function createApp({ config, staticFiles, log }) {
  return function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return json(res, 405, { error: "method_not_allowed" });
    }
    let pathname;
    try {
      pathname = new URL(req.url, "http://local").pathname;
    } catch {
      return json(res, 400, { error: "bad_url" });
    }
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
      if (!serveStatic(staticFiles, req, res, pathname)) json(res, 404, { error: "not_found" }, req.method);
    } catch (err) {
      log.error("request_failed", { path: pathname, error: String(err?.message || err) });
      if (!res.headersSent) json(res, 500, { error: "internal" }, req.method);
      else res.destroy();
    }
  };
}
