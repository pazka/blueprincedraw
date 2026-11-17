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

## Agent system: QA gate, journal, "what happened to X"
**Before any work in this repo, whatever the request:** read the hub `pazka/hosh-management`:
`AGENTS.md` (how the hosh.it agents and the owner work together), `README.md` (every app, site, repo and
journal), `roles/` (the full procedure of each agent: QA, Security, Developer, DevOps, dependency updates).
`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`
(same for `README.md`, `roles/README.md`, `roles/qa.md`...). Those rules apply here; this file adds the
repo's own.

Canonical rules: `AGENTS.md` in the private hub `pazka/hosh-management`
(`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`).
Summary, binding for every agent that works in this repo:
- **Nothing is merged without the independent QA agent.** Work on `agent/<topic>-<yyyymmdd>`, get CI
  green, write in the PR body what changed, which use cases it touches and how it was tested, then add
  the label `qa:requested`. Merge only when the PR has `qa:approved` AND a comment
  `QA-VERDICT: APPROVED sha=<current head sha>`. On `qa:changes-requested`: fix on the same branch,
  answer each finding, ask again; QA re-tests the whole PR. Never approve your own PR. After QA's
  approval the agent that opened the PR merges it: this replaces "the owner merges" and "merge when
  CI is green" wherever this file still says so.
- **Owner fast lane**: when the owner asks for a feature in a session he is in, do it end to end in
  that session (discuss, develop, QA by a fresh independent QA subagent or a QA routine run now, merge,
  release, deploy, show the live URL). Rules: AGENTS.md section 2b. The session that wrote the code never
  writes the verdict.
- **QA owns the tests and the visual regression**: every use case a user can reach (listed in
  `TESTING.md`), screenshots at 1400 / 1024 / 390 px, baselines in the repo. A wanted visual change
  must be announced in the PR. Never weaken a test or a gate to get green.
- A NEW third-party dependency always needs the owner: open an issue in `pazka/hosh-management`
  labelled `ready-for-human` (that label is the list of places where the owner is needed).
- Release = Actions → release with `version=vX.Y.Z` on the default branch. Never push a git tag.
- **Journal**: after each event (PR ready, QA verdict, merge, release, deploy, rollback, incident,
  blocker) add one comment to this project's journal, `pazka/hosh-management#11`.
- **When the owner asks "what happened to X"** (this app, another one, or the server): open the index
  in `pazka/hosh-management` `README.md`, read the last comments of X's journal issue
  (`gh issue view <n> -R pazka/hosh-management --comments`), then the open `ready-for-human` issues,
  then PRs / Actions runs if needed. Server facts you cannot see: ask the Box agent (mailbox from a
  laptop session, or an issue labelled `box-question`). Answer with: what happened (dated), the state
  now, where the owner is needed.
- Online checks use only the URLs in `pazka/hosh-management` `uptime/checks.json`.
