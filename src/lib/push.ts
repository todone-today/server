import webpush from "web-push";
import { db } from "./db";
import { localNow, dueNotes } from "./reminders";
import type { Task } from "./tasks";

// Web Push with this server's VAPID key pair (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
export const pushReady = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
let configured = false;
function configure() {
  if (configured || !pushReady()) return pushReady();
  const url = process.env.BETTER_AUTH_URL ?? "";
  webpush.setVapidDetails(
    url.startsWith("https://") ? url : "https://github.com/1stdevfriend/todone",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  return (configured = true);
}

type Payload = { title: string; body: string; url?: string; tag?: string };

// Sends to every device the person turned notifications on for; drops devices the push service says are gone.
export async function sendTo(userId: string, payload: Payload): Promise<number> {
  if (!configure()) return 0;
  const { rows } = await db.query<{ endpoint: string; p256dh: string; auth: string }>(
    `select endpoint, p256dh, auth from push_sub where "userId" = $1`,
    [userId],
  );
  let sent = 0;
  for (const r of rows)
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        JSON.stringify(payload),
        {
          TTL: 60 * 60,
        },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.query(`delete from push_sub where endpoint = $1`, [r.endpoint]);
    }
  return sent;
}

// The scheduled run: for everyone with notifications on, sends what's due now in their time zone, once.
export async function runReminders(now = new Date()) {
  const { rows: people } = await db.query<{ userId: string; timeZone: string }>(
    `select distinct on ("userId") "userId", "timeZone" from push_sub order by "userId", "createdAt" desc`,
  );
  let sent = 0;
  for (const { userId, timeZone } of people) {
    const { today, nowMin } = localNow(now, timeZone);
    // Their own lists and their teams' lists.
    const { rows: lists } = await db.query<{ name: string; tasks: Task[] }>(
      `select name, tasks from list where kind = 'list' and ("userId" = $1
         or "organizationId" in (select "organizationId" from member where "userId" = $1))`,
      [userId],
    );
    const items = lists.flatMap((l) => l.tasks.flatMap((t) => [t, ...t.sub]).map((task) => ({ task, list: l.name })));
    for (const n of dueNotes(items, today, nowMin)) {
      const fresh = await db.query(
        `insert into push_sent ("userId", key) values ($1, $2) on conflict do nothing returning key`,
        [userId, n.key],
      );
      if (fresh.rowCount) sent += await sendTo(userId, { title: n.title, body: n.body, tag: n.key, url: "/app" });
    }
  }
  await db.query(`delete from push_sent where "sentAt" < now() - interval '3 days'`);
  return { people: people.length, sent };
}
