import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Sentry from "@sentry/node";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { ApiError, later, request } from "./context.ts";
import { clientIp, hit, pruneRateLimits, ruleFor } from "./lib/rate-limit.ts";
import { auth, hasDiscord, hasGithub, hasGoogle, purgeUnverified, verifiesEmail } from "./lib/auth.ts";
import { db as pool } from "./lib/db.ts";
import { demoLists } from "./lib/demo.ts";
import * as lists from "./actions/lists.ts";
import * as integrations from "./actions/integrations.ts";
import * as keys from "./actions/keys.ts";
import * as files from "./actions/files.ts";
import * as shares from "./actions/shares.ts";
import * as push from "./actions/push.ts";
import * as billing from "./actions/billing.ts";
import { hasFiles } from "./lib/r2.ts";
import { cron } from "./actions/cron.ts";
import { feed } from "./actions/feed.ts";
import { sharedView } from "./actions/shared.ts";
import { syncedLists } from "./actions/sync-all-lists.ts";
import { getList, putList } from "./actions/sync-list.ts";

// The JSON API the clients call. Browsers reach it through the web app's /api (same origin), so the session
// cookie and OAuth callbacks belong to the web app's address.
const app = new Hono();

app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
app.use("*", secureHeaders());
// Every handler can find out who's asking (see context.ts).
app.use("*", (c, next) => request.run(c.req.raw.headers, next));

// Rate limits per client address (lib/rate-limit.ts); sign-in and the like have Better Auth's own.
app.use("/api/*", async (c, next) => {
  const rule = ruleFor(c.req.method, c.req.path);
  const wait = rule && (await hit(rule, clientIp(c.req.raw.headers)));
  if (wait) return c.json({ error: "Too many requests. Try again in a moment." }, 429, { "retry-after": String(wait) });
  await next();
});

app.onError((e, c) => {
  if (e instanceof ApiError) return c.json({ error: e.message }, e.status);
  if (e instanceof HTTPException) return e.getResponse(); // e.g. the CSRF check's 403
  console.error(e);
  Sentry.captureException(e);
  return c.json({ error: "Something went wrong." }, 500);
});

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" ? b : {};
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

// Accounts, sessions and teams: Better Auth checks the origin of its own requests.
app.on(["GET", "POST"], "/api/auth/*", (c) => {
  // The 7-day clean-up of unconfirmed accounts also runs on each sign-up, so it happens without a scheduler.
  if (c.req.path === "/api/auth/sign-up/email") later(() => Promise.all([purgeUnverified(), pruneRateLimits()]));
  return auth.handler(c.req.raw);
});
app.get("/api/config", (c) => c.json({ github: hasGithub, google: hasGoogle, discord: hasDiscord, verifiesEmail, files: hasFiles }));
// The sample lists for the demo at /demo, dated from the visitor's today. Nothing is stored.
app.get("/api/demo", (c) => {
  const q = c.req.query("today") ?? "";
  const today = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
  return c.json(demoLists(today));
});
// For the status page and uptime checks: is the API up, and can it reach the database?
app.get("/api/health", async (c) => {
  const t = performance.now();
  const db = await pool
    .query("select 1")
    .then(() => true)
    .catch(() => false);
  return c.json({ api: true, db, ms: Math.round(performance.now() - t) }, db ? 200 : 503, { "cache-control": "no-store" });
});

// Links that work without signing in: each is guarded by its own secret token.
app.get("/api/calendar/:file", (c) => feed(c.req.raw, c.req.param("file")));
app.get("/api/shared/:token", async (c) => {
  const v = await sharedView(c.req.param("token"));
  return v ? c.json(v) : c.json({ error: "Not found" }, 404);
});
app.get("/api/sync/:token", (c) => syncedLists(c.req.param("token")));
app.get("/api/sync/:token/:list", (c) => getList(c.req.param("token"), c.req.param("list")));
app.put("/api/sync/:token/:list", (c) => putList(c.req.raw, c.req.param("token"), c.req.param("list")));
app.get("/api/cron/notify", (c) => cron(c.req.raw));
// Razorpay's webhooks: signed with the webhook secret over the raw body, so no session or CSRF check.
app.post("/api/billing/webhook", async (c) =>
  c.json(await billing.webhook(await c.req.text(), c.req.header("x-razorpay-signature"), c.req.header("x-razorpay-event-id"))),
);
// Before signing in, and forgot-password: how to derive keys, and the recovery-key reset (token-guarded).
// A shared task's link (no account): the token is the key. The guest's random browser key comes in x-guest.
app.get("/api/s/:token", async (c) => c.json(await shares.guestView(c.req.param("token"), c.req.header("x-guest"))));
app.post("/api/s/:token/comments", async (c) => {
  const share = await shares.byToken(c.req.param("token"));
  const b = await body(c);
  const guest = await shares.guestNo(share, c.req.header("x-guest"), true);
  if ("name" in b) await shares.nameGuest(share, guest, b.name);
  return c.json(await shares.addComment(share, b, { guest }));
});
app.post("/api/s/:token/files", async (c) =>
  c.json(await shares.shareUpload(await shares.byToken(c.req.param("token")), await body(c))),
);
app.post("/api/s/:token/files/:id/done", async (c) =>
  c.json(await shares.shareConfirm(await shares.byToken(c.req.param("token")), c.req.param("id"))),
);
app.get("/api/s/:token/files/:id", async (c) =>
  c.json(await shares.shareLink(await shares.byToken(c.req.param("token")), c.req.param("id"))),
);
app.post("/api/prelogin", async (c) => c.json(await keys.prelogin((await body(c)).email)));
app.post("/api/keys/recovery", async (c) => c.json(await keys.recoveryFor((await body(c)).token)));
app.post("/api/keys/recover", async (c) => c.json(await keys.recover(await body(c))));
app.post("/api/keys/reset-account", async (c) => c.json(await keys.resetAccount(await body(c))));

// Everything below is the signed-in person's own data. Cross-site form posts are refused; JSON from another
// site can't be sent without a CORS preflight, which this server never grants.
// The web app's address, plus any other sites Better Auth trusts (e.g. a preview next to production).
const origins = [process.env.BETTER_AUTH_URL, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(",")]
  .filter((u): u is string => !!u?.trim())
  .map((u) => new URL(u.trim()).origin);
const me = new Hono();
me.use("*", csrf(origins.length ? { origin: origins } : undefined));

me.get("/lists", async (c) => c.json(await lists.fetchLists()));
me.post("/lists", async (c) => {
  const b = await body(c);
  return c.json(await lists.createList(str(b.id), b.name, b.tasks, b.kind, b.data, b.icon));
});
me.put("/lists/order", async (c) => c.json(await lists.reorderLists((await body(c)).ids)));
me.put("/lists/:id", async (c) => {
  const b = await body(c);
  return c.json(await lists.saveList(c.req.param("id"), Number(b.version), b.name, b.tasks, b.data, b.icon));
});
me.delete("/lists/:id", async (c) => c.json(await lists.deleteList(c.req.param("id"))));
me.post("/onboarding", async (c) => c.json(await lists.startOnboarding()));
me.get("/export", async (c) => c.json(await lists.exportData()));
me.post("/feedback", async (c) => {
  const b = await body(c);
  return c.json(await lists.sendFeedback(str(b.kind), str(b.body), str(b.page)));
});

me.get("/integrations", async (c) => c.json(await integrations.getIntegrations()));
me.put("/integrations/calendar", async (c) => c.json(await integrations.setCalendar(!!(await body(c)).on)));
me.put("/integrations/markdown", async (c) => c.json(await integrations.setMarkdownSync(!!(await body(c)).on)));
me.put("/integrations/discord", async (c) => c.json(await integrations.setDiscord(str((await body(c)).url) || null)));
me.put("/integrations/notion", async (c) => {
  const b = await body(c);
  return c.json(await integrations.setNotion(str(b.token) || null, str(b.database), str(b.timeZone)));
});
me.post("/integrations/google", async (c) => c.json(await integrations.connectGoogle(str((await body(c)).timeZone))));
me.delete("/integrations/google", async (c) => c.json(await integrations.disconnectGoogle()));
me.post("/integrations/sync", async (c) => c.json(await integrations.syncNow()));
me.get("/shares", async (c) => c.json(await integrations.listShares()));
me.post("/shares", async (c) => {
  const b = await body(c);
  return c.json(await integrations.shareCalendar(b.view, b.at));
});
me.delete("/shares/:token", async (c) => c.json(await integrations.stopShare(c.req.param("token"))));

me.post("/files", async (c) => c.json(await files.createFile(await body(c))));
me.post("/files/:id/done", async (c) => c.json(await files.confirmFile(c.req.param("id"))));
me.get("/files/:id", async (c) => c.json(await files.fileLink(c.req.param("id"))));
me.delete("/files/:id", async (c) => c.json(await files.deleteFile(c.req.param("id"))));
me.post("/task-shares", async (c) => c.json(await shares.createShare((await body(c)).task)));
me.get("/task-shares", async (c) => c.json(await shares.guestCounts()));
me.get("/task-shares/:id", async (c) => c.json(await shares.ownerView(c.req.param("id"))));
me.put("/task-shares/:id", async (c) => {
  const b = await body(c);
  return c.json(await shares.updateShare(c.req.param("id"), b.task, b.files));
});
me.post("/task-shares/:id/rotate", async (c) => c.json(await shares.rotateShare(c.req.param("id"))));
me.delete("/task-shares/:id", async (c) => c.json(await shares.revokeShare(c.req.param("id"))));
me.post("/task-shares/:id/comments", async (c) => c.json(await shares.ownerComment(c.req.param("id"), await body(c))));
me.post("/task-shares/:id/files", async (c) => c.json(await shares.ownerUpload(c.req.param("id"), await body(c))));
me.post("/task-shares/:id/files/:f/done", async (c) =>
  c.json(await shares.ownerConfirm(c.req.param("id"), c.req.param("f"))),
);
me.get("/task-shares/:id/files/:f", async (c) => c.json(await shares.ownerLink(c.req.param("id"), c.req.param("f"))));
me.get("/keys", async (c) => c.json(await keys.myKeys()));
me.post("/keys/setup", async (c) => c.json(await keys.setupKeys(await body(c))));
me.post("/keys/init", async (c) => c.json(await keys.initKeys(await body(c))));
me.post("/keys/passphrase", async (c) => c.json(await keys.setPassphrase(await body(c))));
me.post("/keys/password", async (c) => c.json(await keys.changePassword(await body(c))));
me.post("/keys/recovery-key", async (c) => c.json(await keys.newRecoveryKey(await body(c))));
me.get("/orgs/:id/keys", async (c) => c.json(await keys.teamKeys(c.req.param("id"))));
me.put("/orgs/:id/keys", async (c) => c.json(await keys.giveTeamKeys(c.req.param("id"), (await body(c)).keys)));

// Reminders with the app closed: this browser's push address, and the reminders the app sealed for it.
me.get("/push/key", async (c) => c.json(await push.pushKey()));
me.get("/push/devices", async (c) => c.json(await push.devices()));
me.post("/push/devices", async (c) => c.json(await push.addDevice(await body(c))));
me.delete("/push/devices", async (c) => c.json(await push.removeDevice((await body(c)).endpoint)));
me.put("/push/devices/:id/notes", async (c) => c.json(await push.setNotes(c.req.param("id"), await body(c))));

// Plans and payments (actions/billing.ts).
me.get("/billing", async (c) => c.json(await billing.status()));
me.post("/billing/quote", async (c) => c.json(await billing.quote(await body(c))));
me.post("/billing/checkout", async (c) => c.json(await billing.checkout(await body(c))));
me.post("/billing/founding", async (c) => c.json(await billing.founding()));
me.post("/billing/confirm", async (c) => c.json(await billing.confirm(await body(c))));
me.post("/billing/cancel", async (c) => c.json(await billing.cancel()));
me.post("/billing/refund", async (c) => c.json(await billing.refund()));
me.get("/billing/receipts/:id", async (c) => c.json(await billing.receipt(c.req.param("id"))));

app.route("/api", me);
app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
