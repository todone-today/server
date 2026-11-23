// Sentry tunnel for the web app: the browser posts error reports to its own address (so ad blockers don't drop them)
// and this passes them on. Only to the web app's own Sentry project (WEB_SENTRY_DSN): anything addressed elsewhere is
// refused, so this can't relay for others.
const dsn = process.env.WEB_SENTRY_DSN ? new URL(process.env.WEB_SENTRY_DSN) : null;

export async function tunnel(body: string) {
  if (!dsn) return new Response(null, { status: 404 });
  if (body.length > 1_000_000) return new Response(null, { status: 413 });
  let to: URL;
  try {
    to = new URL(JSON.parse(body.slice(0, body.indexOf("\n"))).dsn);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (to.host !== dsn.host || to.pathname !== dsn.pathname) return new Response(null, { status: 400 });
  const r = await fetch(`https://${dsn.host}/api${dsn.pathname}/envelope/`, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope" },
    body,
  });
  if (!r.ok) console.error("sentry tunnel", r.status, r.headers.get("x-sentry-error"), (await r.text()).slice(0, 300));
  return new Response(null, { status: r.status });
}
