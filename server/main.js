/** BlueprinceDraw static server: `node server/main.js` (container: /app/server/main.js). */

import { createServer } from "node:http";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { loadStatic } from "./static.js";

const config = loadConfig();
const log = createLogger(config.logLevel);
const staticFiles = await loadStatic(config.staticDir);

const server = createServer(createApp({ config, staticFiles, log }));
server.requestTimeout = 60 * 1000;
server.headersTimeout = 20 * 1000;
server.keepAliveTimeout = 65 * 1000;

server.listen(config.port, config.host, () =>
  log.info("listening", { port: config.port, version: config.version, static_files: staticFiles.size }),
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log.info("shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
