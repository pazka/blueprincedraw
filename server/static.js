/**
 * Serves the built front-end (dist/). The file list is read once at start-up
 * and requests are looked up in it, so no request path ever reaches the file
 * system: traversal and dotfiles are impossible by construction. Text assets
 * are pre-compressed at build time (scripts/precompress.mjs); the .br / .gz
 * twin is sent when the browser accepts it.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

// Content-hashed file names. Everything vite writes to /assets/ is hashed (and its base64url
// hash may itself contain "-", e.g. index-Ab-dE9_x.js); Excalidraw's fonts and locales carry a
// hash too (Xiaolai-Regular-3e1f…woff2, fr-FR-ABCD1234.js).
const HASHED = /^\/assets\/|-[A-Za-z0-9]{8,}\.[a-z0-9]+$/;

export async function loadStatic(root) {
  const files = new Map();
  const walk = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(path);
        continue;
      }
      const ext = extname(ent.name);
      if (ext === ".br" || ext === ".gz" || ext === ".map" || !TYPES[ext]) continue;
      const url = "/" + relative(root, path).split(sep).join("/");
      const s = await stat(path);
      const variants = {};
      for (const enc of ["br", "gzip"]) {
        const twin = `${path}.${enc === "br" ? "br" : "gz"}`;
        const t = await stat(twin).catch(() => null);
        if (t) variants[enc] = { path: twin, size: t.size };
      }
      files.set(url, {
        path,
        size: s.size,
        type: TYPES[ext],
        etag: `"${createHash("sha1").update(`${url}:${s.size}:${s.mtimeMs}`).digest("hex").slice(0, 16)}"`,
        cache:
          url === "/index.html"
            ? "no-cache"
            : HASHED.test(url)
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600",
        variants,
      });
    }
  };
  await walk(root);
  if (!files.has("/index.html")) throw new Error(`no index.html in ${root} (run npm run build)`);
  return files;
}

function pickEncoding(accept, variants) {
  const a = String(accept || "");
  if (variants.br && /\bbr\b/.test(a)) return "br";
  if (variants.gzip && /\bgzip\b/.test(a)) return "gzip";
  return null;
}

/** @returns true when the request was answered */
export function serveStatic(files, req, res, pathname) {
  const file = files.get(pathname === "/" ? "/index.html" : pathname);
  if (!file) return false;

  const enc = pickEncoding(req.headers["accept-encoding"], file.variants);
  // one ETag per representation, so a cache never pairs gzip bytes with a br validator
  const etag = enc ? `${file.etag.slice(0, -1)}-${enc}"` : file.etag;
  const headers = {
    "Content-Type": file.type,
    "Cache-Control": file.cache,
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const source = enc ? file.variants[enc] : file;
  if (enc) headers["Content-Encoding"] = enc;
  headers["Content-Length"] = source.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(source.path).on("error", () => res.destroy()).pipe(res);
  return true;
}
