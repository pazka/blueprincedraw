/** Environment-only configuration (box contract rule 6). The server holds no
 *  state and no secret: every value has a default that works on the box. */

import { fileURLToPath } from "node:url";

function positive(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env = process.env) {
  return {
    port: positive(env, "APP_PORT", 8000),
    host: env.APP_HOST || "0.0.0.0",
    staticDir: env.APP_STATIC_DIR || fileURLToPath(new URL("../dist", import.meta.url)),
    logLevel: env.APP_LOG_LEVEL || "info",
    version: env.APP_VERSION || "dev",
  };
}
