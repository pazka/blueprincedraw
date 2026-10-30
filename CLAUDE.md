# CLAUDE.md for pazka/blueprincedraw

Excalidraw for humongous boards (the owner's Blue Prince board: ~1,300 elements, ~490 screenshots).
Live at **https://excalidraw.hosh.it** on the owner's hosh.it box. **`docs/BOX-CONTRACT.md` is binding.**

| | |
|---|---|
| Image | `ghcr.io/pazka/blueprincedraw` |
| Host | `excalidraw.hosh.it` |
| Loopback port | `127.0.0.1:9132` → container port 8000 |
| Data | none on the server (no volume) |
| Env file on the box | `/srv/blueprincedraw/blueprincedraw.env` (no secret) |

## Product rules (owner decisions, do not undo)
- **Nothing is stored server-side and there is no login.** The save is ONE classic `.excalidraw`
  file (scene + images, excalidraw.com format, any size) written and read by streaming
  (`lib/sceneFile.ts`, `lib/jsonStream.ts`); the browser keeps a working copy (IndexedDB or a
  folder). Do not add an API, accounts, uploads or sync without the owner asking for it explicitly.
- **Never break existing data:** every `.excalidraw` saved before must open, every board stored
  in IndexedDB or a folder by an earlier version must open, and opening a file never drops images
  already stored (the index is merged, and `recoverIndex` re-lists orphaned binaries).
- **No step may hold a whole file in memory** (V8 strings stop at 512 MB). The big-file test
  (`BPD_BIG_FILE=1`, run in CI) must stay green.
- Keep it simple: the server is a static file server (`server/`, Node stdlib only, GET/HEAD).
- Never a CDN, analytics or third-party request: the CSP in `server/app.js` forbids them.

## Layout
- `src/`: the editor (React + `@excalidraw/excalidraw`), storage back ends (`lib/store.ts`), streamed
  importer (`lib/jsonStream.ts`, `worker/`), progressive image loading (`lib/project.ts`).
- `server/`: `main.js` (entry), `app.js` (headers, routes), `static.js` (prebuilt file map),
  `smoke.js` (POST_DEPLOY capability checks), `healthcheck.js`.
- `test/`: `npm test` (node:test; `.ts` runs through Node's type stripping, so no parameter
  properties / enums in files the tests import).

## Rules
- Supply chain: every new third-party dependency needs the owner's explicit yes. `.npmrc`
  (ignore-scripts, save-exact, min-release-age=7) stays. Never install/build/test on the box.
- Every behaviour change gets a test that fails on the old code.
- Deploying = cutting a release (`vX.Y.Z` tag or Actions → release); see `DEPLOY.md`.
- Commit in small, clearly described steps on `main`. Never commit `.excalidraw` files or `*.env`.
