/**
 * JSON lines on stdout (box contract rule 8, hosh-management AGENTS.md section 11): one object per
 * line with ts, level, service, version, event (stable snake_case name, the thing to count), msg,
 * then the line's own fields. Never a request path, query string, body, IP, cookie or user agent.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const SERVICE = "blueprincedraw";

/** @param {string} level  debug | info | warn | error (anything else: info) */
export function createLogger(level = "info", out = process.stdout, { version = "dev" } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const enabled = (lvl) => LEVELS[lvl] >= min;
  const emit = (lvl) => (event, msg, fields = {}) => {
    if (!enabled(lvl)) return;
    out.write(
      JSON.stringify({ ts: new Date().toISOString(), level: lvl, service: SERVICE, version, event, msg, ...fields }) +
        "\n",
    );
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), enabled };
}

/**
 * The `err` field of an error line: type, message and stack. Each string in `hide` (the raw request
 * URL, for instance) is replaced by "<hidden>" so a path or query string never reaches the log.
 */
export function errField(e, hide = []) {
  const clean = (s) => hide.filter(Boolean).reduce((t, h) => t.replaceAll(h, "<hidden>"), String(s));
  if (e instanceof Error) {
    return { err: { type: e.name, message: clean(e.message), ...(e.stack ? { stack: clean(e.stack) } : {}) } };
  }
  return { err: { type: typeof e, message: clean(e) } };
}
