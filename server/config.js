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

/** The variables this server reads. The startup line lists the ones that are set, never their values. */
export const CONFIG_NAMES = ["APP_PORT", "APP_HOST", "APP_STATIC_DIR", "APP_LOG_LEVEL", "LOG_LEVEL", "APP_VERSION"];

export function configNamesSet(env = process.env) {
  return CONFIG_NAMES.filter((n) => env[n] !== undefined && env[n] !== "");
}

export function loadConfig(env = process.env) {
  return {
    port: positive(env, "APP_PORT", 8000),
    host: env.APP_HOST || "0.0.0.0",
    staticDir: env.APP_STATIC_DIR || fileURLToPath(new URL("../dist", import.meta.url)),
    logLevel: env.APP_LOG_LEVEL || env.LOG_LEVEL || "info",
    version: env.APP_VERSION || "dev",
  };
}
