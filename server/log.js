/** JSON lines on stdout (box contract rule 8). No request logging: Traefik's
 *  access log already covers that, and the app never sees user data. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info", out = process.stdout) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    out.write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }) + "\n");
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
