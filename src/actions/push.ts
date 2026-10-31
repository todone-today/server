"use server";

import { who } from "@/lib/access";
import { db } from "@/lib/db";
import { pushReady, sendTo } from "@/lib/push";

// The public half of the VAPID pair, for the browser to subscribe with; null if push isn't set up here.
export async function pushKey(): Promise<string | null> {
  await who();
  return pushReady() ? process.env.VAPID_PUBLIC_KEY! : null;
}

// Saves this device's push subscription for the signed-in person.
export async function subscribePush(sub: unknown, timeZone: unknown): Promise<string> {
  const { user } = await who();
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const ok = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (
    !ok(s?.endpoint, 1000) ||
    !(s.endpoint as string).startsWith("https://") ||
    !ok(s.keys?.p256dh, 200) ||
    !ok(s.keys?.auth, 100)
  )
    return "That subscription doesn't look right.";
  const tz = typeof timeZone === "string" && Intl.supportedValuesOf("timeZone").includes(timeZone) ? timeZone : "UTC";
  await db.query(
    `insert into push_sub (endpoint, "userId", p256dh, auth, "timeZone") values ($1, $2, $3, $4, $5)
     on conflict (endpoint) do update set "userId" = $2, p256dh = $3, auth = $4, "timeZone" = $5`,
    [s.endpoint, user, s.keys!.p256dh, s.keys!.auth, tz],
  );
  return "";
}

export async function unsubscribePush(endpoint: unknown): Promise<void> {
  const { user } = await who();
  if (typeof endpoint === "string")
    await db.query(`delete from push_sub where endpoint = $1 and "userId" = $2`, [endpoint, user]);
}

export async function testPush(): Promise<string> {
  const { user } = await who();
  const n = await sendTo(user, {
    title: "todone",
    body: "Notifications are on. You'll hear about tasks before they start.",
    url: "/app",
  });
  return n ? `Sent to ${n} device${n === 1 ? "" : "s"}.` : "No device has notifications on yet.";
}
