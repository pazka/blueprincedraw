# Deploying excalidraw.hosh.it

Deployment on the hosh.it box (box standard: `docs/BOX-CONTRACT.md`). Releases deploy themselves
through **hosh-deploy** (§1); a first install is a one-time on-box step (§1b). `.env.example`
defaults already fit the box, and there is **no secret at all**: the app has no login and stores
nothing on the server. Boards live only in each visitor's browser (IndexedDB) or in a local folder
they pick; moving a board between machines = Export / Import of a `.excalidraw` file.

## 1. How releases go live (hosh-deploy — the only deploy path on the box)

Every release (`release` workflow: tag `vX.Y.Z` or Actions → release) ends with the **`deploy`** job:
GitHub connects to the box as `deployer` with this repo's `HOSH_DEPLOY_KEY` (bound to blueprincedraw
only) and runs `hosh-deploy deploy blueprincedraw vX.Y.Z`. The box pulls the image, swaps the tag in
`blueprincedraw.env`, waits healthy, checks `/healthz` on the loopback port and through Traefik, runs
`POST_DEPLOY` inside the container (`deploy/hosh-deploy.conf`) and **rolls back by itself** if any
check fails (the workflow then goes red). Nothing from the repo runs on the host.

- Redeploy / roll forward / back: Actions → **deploy** → `vX.Y.Z`, `rollback` or `status`.
- On the box: `sudo hosh-deploy deploy blueprincedraw vX.Y.Z`, `sudo hosh-deploy rollback blueprincedraw`,
  `sudo hosh-deploy status blueprincedraw`. Log: `/var/log/hosh-deploy.log`.
- Repo variable `HOSH_AUTODEPLOY=false` stops auto-deploy after releases (manual dispatch still works).

## 1b. First install on the box (once; on-box Claude in an owner-opened sudo window)

Box rules: `ACTIONS-LOG.md` intent BEFORE, result + revert AFTER; `/home/pazka/MIGRATION/scripts/smoke.sh`
BEFORE and AFTER. Prerequisites: DNS `excalidraw.hosh.it` A → 54.37.70.57 (`scripts/dns-add.sh excalidraw`),
port 9132 in the registry of `11-BOX-STANDARD.md`, release `v1.0.0` built (image on GHCR).

```sh
# A — release checkout (provides docker-compose.example.yml, .env.example, deploy/*)
sudo mkdir -p /srv/blueprincedraw && sudo chmod 750 /srv/blueprincedraw
sudo bash -c 'cd /srv/blueprincedraw && { [ -d .git ] || { git init -q && git remote add origin https://github.com/pazka/blueprincedraw; }; } && git fetch -q --depth 1 origin tag v1.0.0 && git checkout -q v1.0.0'
# B — env file from the template (no secret exists for this app)
sudo bash -c 'cd /srv/blueprincedraw && { [ -e blueprincedraw.env ] || install -m 600 .env.example blueprincedraw.env; }'
# C — (none: no owner secret)
# D — pin the box config (validates the compose hardening), first deploy (writes the Traefik route)
sudo hosh-deploy register blueprincedraw
sudo hosh-deploy deploy blueprincedraw v1.0.0
# E — GitHub key for auto-deploys (keygen; root binds the public half; gh stores the private half; shred)
ssh-keygen -q -t ed25519 -N '' -C hosh-deploy:blueprincedraw -f /tmp/blueprincedraw-deploy
sudo bash /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh key blueprincedraw /tmp/blueprincedraw-deploy.pub
gh secret set HOSH_DEPLOY_KEY -R pazka/blueprincedraw < /tmp/blueprincedraw-deploy && shred -u /tmp/blueprincedraw-deploy /tmp/blueprincedraw-deploy.pub
```
Then add `svc_blueprincedraw` to the box smoke harness (`scripts/smoke.sh`) from §3, `excalidraw.hosh.it`
in `TLS_HOSTS`, run `scripts/smoke.sh all` (AFTER), commit the route in `/root/hosh-deploy`, set the
registry line to `live`, and test the GitHub path once: Actions → deploy → `status`.

**Revert:** `cd /srv/blueprincedraw && sudo docker compose --env-file blueprincedraw.env down` +
`sudo rm /root/hosh-deploy/edge/traefik/dynamic/blueprincedraw.yml /etc/hosh-deploy/apps/blueprincedraw.conf` +
`sudo bash /home/pazka/MIGRATION/scripts/setup-hosh-deploy.sh unkey blueprincedraw` +
`gh secret delete HOSH_DEPLOY_KEY -R pazka/blueprincedraw` + `sudo rm -rf /srv/blueprincedraw`.
No volume to keep: the app has no server-side data.

## 2. Variables (`blueprincedraw.env`, mode 600)
| Variable | Default | Set by | Meaning |
|---|---|---|---|
| `APP_IMAGE` | `ghcr.io/pazka/blueprincedraw:v1.0.0` | hosh-deploy | Release tag running (the only line hosh-deploy rewrites). |
| `APP_BIND` | `127.0.0.1:9132` | template | Loopback port published for Traefik. |
| `APP_LOG_LEVEL` | `info` | template | `debug`, `info`, `warn`, `error`. |
| `APP_PORT` | `8000` (unset) | — | Listening port inside the container; leave unset. |
| `APP_STATIC_DIR` | `/app/dist` (unset) | — | Built front-end; leave unset. |

## 3. Capability checks (what "works" means — not just a 200)
All run by **`/nodejs/bin/node /app/server/smoke.js http://127.0.0.1:8000`** inside the container
(`POST_DEPLOY` after every deploy; non-zero ⇒ automatic rollback) and in CI against the hardened container.

| Feature | Request → expected |
|---|---|
| Health | `GET /healthz` → 200 `{"status":"ok","index":true,"files":~420,"fonts":~234,"locales":~55,…}` |
| Page + CSP | `GET /` → 200 HTML, CSP `default-src 'self'; script-src 'self'; connect-src 'self' …; frame-ancestors 'none'`, `nosniff`, no inline script, no absolute URL (no CDN) |
| Bundle | the `/assets/*.js` of index.html → 200, `Content-Encoding: br`, `immutable` |
| Fonts/locales | served by the app itself: `/fonts/Liberation/LiberationSans-Regular.woff2` → 200 `font/woff2`; `/fonts/` → 404 (no listing) |
| Dotfiles/sources | `/.env`, `/.git/config`, `/server/main.js`, `/package.json` → 404 |
| Read-only | `POST`/`PUT`/`DELETE /` → 405 (the server accepts no data) |
| Browser (manual) | open https://excalidraw.hosh.it, Menu → Import a `.excalidraw`, reload: the board comes back from browser storage; DevTools console shows no CSP error and no request leaves the origin |

## 4. What runs
| Item | Value |
|---|---|
| Image | `ghcr.io/pazka/blueprincedraw:vX.Y.Z` (distroless Node 24, uid 10001, ~50 MB) |
| Upstream | container :8000 → `127.0.0.1:9132` |
| Edge | `/root/hosh-deploy/edge/traefik/dynamic/blueprincedraw.yml` (router `blueprincedraw@file`, resolver `le`, HSTS) |
| Volume | none (stateless) |
| Health | `GET /healthz` → `{"status":"ok", …}` |
| Outbound | none |

## 5. Decisions / known limits
- **No server-side storage, no login (owner decision, 2026-10-30).** Saving boards on the server would
  need accounts and would make the box hold user data; the owner wants neither. The server is a
  static file server: it answers `GET`/`HEAD` only, and the CSP's `connect-src 'self'` (plus no API
  on the server) means the page cannot send a board anywhere.
- **Runtime least privilege:** Node's permission model, `--permission --allow-fs-read=/app/`: no file
  writes, no child processes, no workers, no native addons, no env file read. The file list is read
  once at start-up and requests are looked up in it, so traversal and dotfiles are impossible by
  construction. No outbound connection is ever made.
- **No CDN:** Excalidraw's fonts and locales are copied into the build (`scripts/copy-assets.mjs`).
  Excalidraw also lists `esm.sh` as a fallback font source; `vite.config.ts` rewrites it to a
  same-origin dead path, so nothing can leave the site (and the CSP would block it anyway).
- **Supply chain:** runtime dependencies are `@excalidraw/excalidraw`, `react`, `react-dom` (bundled
  into the front-end, none in the image); the server uses only Node's standard library. Exact pins,
  frozen lockfile, `ignore-scripts`, `min-release-age=7`, Dependabot with a 7-day cooldown, base
  images pinned by digest. `lodash-es` is overridden to 4.18.1 (fixes a high advisory in a mermaid
  dependency). **Accepted:** `nanoid` (inside Excalidraw; advisories need non-integer/negative sizes,
  which Excalidraw never passes) and `katex` (low; only in the Mermaid-to-Excalidraw dialog) — no fix
  exists without downgrading Excalidraw.
- **Where boards live:** per browser and per site. A board saved at `http://localhost:4270` (local
  launcher) is not visible at `https://excalidraw.hosh.it` and vice versa: Export there, Import here.
  Browser storage can be cleared by the user or the browser; the app requests persistent storage,
  and a project folder (Chrome/Edge) or regular exports are the durable copies.
