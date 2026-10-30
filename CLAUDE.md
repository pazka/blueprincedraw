# CLAUDE.md — pazka/blueprincedraw

Excalidraw for humongous boards (the owner's Blue Prince board: ~1,300 elements, ~490 screenshots).
Live at **https://excalidraw.hosh.it** on the owner's hosh.it box. **`docs/BOX-CONTRACT.md` is binding.**

| | |
|---|---|
| Image | `ghcr.io/pazka/blueprincedraw` |
| Host | `excalidraw.hosh.it` |
| Loopback port | `127.0.0.1:9132` → container port 8000 |
| Data | none on the server (no volume) |
| Env file on the box | `/srv/blueprincedraw/blueprincedraw.env` (no secret) |

## Product rules (owner decisions — do not undo)
- **Nothing is stored server-side and there is no login.** Boards live in the visitor's browser
  (IndexedDB) or a local folder (File System Access API); moving them = Export / Import. Do not add
  an API, accounts, uploads or sync without the owner asking for it explicitly.
- Keep it simple: the server is a static file server (`server/`, Node stdlib only, GET/HEAD).
- Never a CDN, analytics or third-party request: the CSP in `server/app.js` forbids them.

## Layout
- `src/` — the editor (React + `@excalidraw/excalidraw`), storage back ends (`lib/store.ts`), streamed
  importer (`lib/jsonStream.ts`, `worker/`), progressive image loading (`lib/project.ts`).
- `server/` — `main.js` (entry), `app.js` (headers, routes), `static.js` (prebuilt file map),
  `smoke.js` (POST_DEPLOY capability checks), `healthcheck.js`.
- `test/` — `npm test` (node:test; `.ts` runs through Node's type stripping, so no parameter
  properties / enums in files the tests import).

## Rules
- Supply chain: every new third-party dependency needs the owner's explicit yes. `.npmrc`
  (ignore-scripts, save-exact, min-release-age=7) stays. Never install/build/test on the box.
- Every behaviour change gets a test that fails on the old code.
- Deploying = cutting a release (`vX.Y.Z` tag or Actions → release); see `DEPLOY.md`.
- Commit in small, clearly described steps on `main`. Never commit `.excalidraw` files or `*.env`.
