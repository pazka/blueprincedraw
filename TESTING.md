# TESTING.md: blueprincedraw

How this repo is tested. Rules for every agent: hub `pazka/hosh-management` `AGENTS.md`; this repo's own
rules: `CLAUDE.md` (never break existing data, no whole file in memory, no CDN, no new dependency).

## What runs in CI (`.github/workflows/ci.yml`)
- `test`: `npm ci`, `npm run build` (typecheck + vite), `npm test` (node:test: static server, log format, scene file
  read/write, image streaming, index safety: `recoverIndex` / `syncNewFiles` / `pruneOrphans` never drop a
  stored image that is still listed or used), the big-board round trip (`BPD_BIG_FILE=1`, ~600 MB), `npm audit` (critical).
- `image`: build, Node runtime guard (`scripts/check-node-version.sh`) and its self-test, Trivy CRITICAL gate,
  hardened container smoke + `server/smoke.js` capability checks (the same argv hosh-deploy runs after a
  deploy), then the **visual regression** below.

## Logs (hosh-management AGENTS.md section 11)

`test/log.test.js` pins the format so it cannot rot. One JSON object per line on stdout with `ts` (UTC, ms),
`level`, `service` (`blueprincedraw`), `version` (the release tag, `APP_VERSION`), `event`, `msg`.
- One `startup` line (`port`, `data_dir: "none"`: nothing is stored server-side, `static_files`, `log_level`,
  `config`: the names of the variables that are set, never their values) and one `shutdown` line (`signal`,
  `uptime_s`). A front-end that cannot be loaded gives one `startup_failed` error line and exit code 1.
- Requests are not logged at `info` (Traefik has them): only a 5xx (`error`, event `request_failed` with `err`)
  and an answer slower than 1 s (`warn`, `slow request`). `/healthz` is logged at `debug` only, whatever its
  status (the container healthcheck calls it every 30 s). At `debug` every request.
- Request lines carry `req_id` (the edge's `X-Request-Id` when it is a plain token, else a UUID; always
  returned in the `X-Request-Id` header), `method`, `route` (a template: `/`, `/healthz`, `/assets/*`,
  `/fonts/*`, `/locales/*`, `/:file`, `(not found)`, `(invalid)`; never the path or query string), `status`,
  `dur_ms`, and `aborted: true` when the answer was cut.
- A built file that cannot be read gives `static_read_failed` (`error`, `err`). In every `err` (type, message,
  stack) the raw request URL is replaced by `<hidden>`.
- Level: `APP_LOG_LEVEL` (the box template's name), or the standard's `LOG_LEVEL`; default `info`.

## Visual use cases

Harness: `visual/` (hub AGENTS.md section 3). `bash visual/run.sh <image>` starts the image hardened as on the
box (uid 10001, read-only, no caps, no-new-privileges) and `visual/shoot.mjs` drives the machine's Chrome over
the DevTools protocol (Node built-ins only, no package) through every case below at **1400, 1024 and 390 px**,
then compares each shot with `visual/baseline/<case>-<width>.png`. A page-size change, a page error or more
than 0.1 % of differing pixels fails the job; the diff pictures go to `visual/out/diff/` and, in CI, every
failing shot is printed in the log (`VISUAL_PRINT_NEW=1`).

Determinism: every shot runs in a fresh browser profile (empty IndexedDB = a first-time visitor), with
animations off, UTC clock, en-US locale, a fixed 900 px viewport height. The board of the B cases is a fixed
fixture built in code in `visual/cases.mjs` (7 elements with fixed seeds, one 32x32 PNG made with
`node:zlib`): the repo never holds a `.excalidraw` file. It is opened in the page exactly like **Open…** does
(`window.__bpd.openBlob`, the streamed importer), so nothing is ever uploaded.

| Id | State | Steps |
|---|---|---|
| E1-empty | first visit, empty board, browser storage | open `/`, wait for the editor and a settled status bar |
| E2-menu-open | main menu (Open…, Save, Save as…, folder, WebP, prune, theme, background) | E1, click the menu button |
| E3-help | Excalidraw help dialog | E1, press `?` |
| B1-file-opened | "File opened" panel after opening a .excalidraw file (read, elements, images, payload) | E1, open the fixture, wait for the panel and for the "Opened …" toast to leave |
| B2-board | the opened board: shapes, text, arrow, image; status "All changes saved · 1 image" | B1, Close, fit the board to the window |
| B3-board-selected | one element selected: properties panel | B2, select `room-b` |
| B4-board-dark | dark theme | B2, menu → Dark mode (phone: close the menu) |

On a phone (390 px) Excalidraw shows its mobile layout: no footer, so **no status bar** (save state, storage,
image count and file state are not visible there; the harness checks the stored image through the editor
instead).

Not covered: the boot error page ("Could not open the project", needs a broken IndexedDB), the folder project
and Save / Save as (they need the File System Access picker, a user gesture), the import error panel, the
"updated outside this tab" and overwrite confirmations (`window.confirm`), the "Reconnect folder" / "Allow
saving to the file" links, and a humongous board (the big-file round trip is a unit test, not a picture).

**Panels fit the window:** `.bpd-panel` (File opened, Opening file, busy, boot error) uses `box-sizing:
border-box`, so `width: min(508px, calc(100vw - 32px))` is its outer width: 508 px on desktop and laptop (as
before), 358 px with 16 px margins at 390 px.
B1 fails if the "File opened" panel is wider than the window (it was 406 px at 390 px before
pazka/hosh-management#36).

**Renewing the baselines** (only in a PR that says the visual change is wanted): the baselines are only
meaningful for the Chrome that made them (`visual/baseline/chrome.txt`), which is the GitHub runner's. Push
the change, let the `image` job fail, save its log, then `node visual/from-log.mjs <log> --chrome` writes the
runner's shots into `visual/baseline/`. Look at every changed picture before committing it. Locally,
`bash visual/run.sh blueprincedraw:local --update` does the same with your Chrome (for exploring only).
