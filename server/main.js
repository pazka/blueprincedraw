/** BlueprinceDraw static server: `node server/main.js` (container: /app/server/main.js). */

import { createServer } from "node:http";

import { createApp } from "./app.js";
import { configNamesSet, loadConfig } from "./config.js";
import { createLogger, errField } from "./log.js";
import { loadStatic } from "./static.js";

const config = loadConfig();
const log = createLogger(config.logLevel, process.stdout, { version: config.version });

let staticFiles;
try {
  staticFiles = await loadStatic(config.staticDir);
} catch (err) {
  log.error("startup_failed", "the built front-end could not be loaded", errField(err));
  process.exit(1);
}

const server = createServer(createApp({ config, staticFiles, log }));
server.requestTimeout = 60 * 1000;
server.headersTimeout = 20 * 1000;
server.keepAliveTimeout = 65 * 1000;

server.listen(config.port, config.host, () =>
  log.info("startup", "listening", {
    port: config.port,
    // no data directory: nothing is stored server-side (CLAUDE.md, product rules)
    data_dir: "none",
    static_files: staticFiles.size,
    log_level: config.logLevel,
    config: configNamesSet(),
  }),
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    const started = Date.now();
    log.info("shutdown", "stopping", { signal, uptime_s: Math.round(process.uptime()) });
    server.close(() => {
      log.debug("shutdown_done", "server closed", { dur_ms: Date.now() - started });
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
