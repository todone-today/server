import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { ApiError, request } from "./context.ts";
import { auth, hasGithub, hasGoogle } from "./lib/auth.ts";
import * as lists from "./actions/lists.ts";
import * as integrations from "./actions/integrations.ts";
import * as push from "./actions/push.ts";
import { cron } from "./actions/cron.ts";
import { feed } from "./actions/feed.ts";
import { sharedView } from "./actions/shared.ts";
import { syncedLists } from "./actions/sync-all-lists.ts";
import { getList, putList } from "./actions/sync-list.ts";

// The JSON API the clients call. Browsers reach it through the web app's /api (same origin), so the session
// cookie and OAuth callbacks belong to the web app's address.
const app = new Hono();

app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
// Every handler can find out who's asking (see context.ts).
app.use("*", (c, next) => request.run(c.req.raw.headers, next));

app.onError((e, c) => {
  if (e instanceof ApiError) return c.json({ error: e.message }, e.status);
  if (e instanceof HTTPException) return e.getResponse(); // e.g. the CSRF check's 403
  console.error(e);
  return c.json({ error: "Something went wrong." }, 500);
});

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" ? b : {};
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

// Accounts, sessions and teams: Better Auth checks the origin of its own requests.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.get("/api/config", (c) => c.json({ github: hasGithub, google: hasGoogle }));

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

// Everything below is the signed-in person's own data. Cross-site form posts are refused; JSON from another
// site can't be sent without a CORS preflight, which this server never grants.
const origin = process.env.BETTER_AUTH_URL && new URL(process.env.BETTER_AUTH_URL).origin;
const me = new Hono();
me.use("*", csrf(origin ? { origin } : undefined));

me.get("/lists", async (c) => c.json(await lists.fetchLists()));
me.post("/lists", async (c) => {
  const b = await body(c);
  return c.json(await lists.createList(str(b.id), str(b.name), b.tasks, b.kind));
});
me.put("/lists/order", async (c) => c.json(await lists.reorderLists((await body(c)).ids)));
me.put("/lists/:id", async (c) => {
  const b = await body(c);
  return c.json(await lists.saveList(c.req.param("id"), Number(b.version), str(b.name), b.tasks));
});
me.delete("/lists/:id", async (c) => c.json(await lists.deleteList(c.req.param("id"))));
me.post("/onboarding", async (c) => c.json(await lists.startOnboarding((await body(c)).today)));
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

me.get("/push/key", async (c) => c.json(await push.pushKey()));
me.post("/push/subscription", async (c) => {
  const b = await body(c);
  return c.json(await push.subscribePush(b.sub, b.timeZone));
});
me.delete("/push/subscription", async (c) => c.json(await push.unsubscribePush((await body(c)).endpoint)));
me.post("/push/test", async (c) => c.json(await push.testPush()));

app.route("/api", me);
app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
