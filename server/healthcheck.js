/** Container healthcheck (the image has no shell): exit 0 iff GET /healthz says "ok". */

const port = process.env.APP_PORT || 8000;
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  const body = await res.json();
  process.exitCode = res.ok && body.status === "ok" ? 0 : 1;
} catch {
  process.exitCode = 1;
}
