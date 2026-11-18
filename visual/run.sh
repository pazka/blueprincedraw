#!/usr/bin/env bash
# Visual regression of a built image (hosh-management AGENTS.md section 3, use cases in TESTING.md).
#   visual/run.sh [IMAGE] [--update]      (default blueprincedraw:local)
# Starts the image hardened as on the box (uid 10001 from the image, read-only rootfs, no caps,
# no-new-privileges). The server is stateless: every use case runs in a fresh browser profile, and the
# board of the "B" cases is opened in the page from the fixed fixture of visual/cases.mjs (nothing is
# uploaded). Then visual/shoot.mjs shoots every use case at 1400 / 1024 / 390 and compares with
# visual/baseline/.
# Needs: docker, node >= 22, a Chrome ($CHROME, default google-chrome). No package is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${1:-blueprincedraw:local}"
shift || true
PORT="${VISUAL_PORT:-18320}"
NAME="bpd-visual-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 256m \
  -p "127.0.0.1:$PORT:8000" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { docker logs "$NAME"; exit 1; }

status=0
# localhost: a secure context (IndexedDB, File System Access) as on https://excalidraw.hosh.it
node visual/shoot.mjs "http://localhost:$PORT" "$@" || status=$?
if [ "$status" != 0 ]; then docker logs "$NAME" 2>&1 | tail -n 20; fi
exit "$status"
