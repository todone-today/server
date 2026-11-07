// Reminders with the app closed. Lists are end-to-end encrypted, so the server can't know what's due: the open app
// plans the coming week's reminders, seals each one for a browser (Web Push encryption, sdk/push.ts) and leaves them
// here with a send time. Every minute, what's due goes to that browser's push service. The server sees when, never what.
import { createPrivateKey, generateKeyPairSync, randomUUID, sign, type JsonWebKey } from "node:crypto";
import { bad, ApiError } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";

// Only the browsers' own push services: the server posts to these addresses, so nothing else may be one.
const PUSH_HOST = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const KEY = /^[\w-]{80,100}$/;
const AUTH = /^[\w-]{16,32}$/;
const MAX_NOTES = 200;
const MAX_DEVICES = 20;
const SUBJECT = `mailto:${/<([^>]+)>/.exec(process.env.EMAIL_FROM ?? "")?.[1] ?? "hello@todone.today"}`;

let vapid: Promise<{ pub: string; jwk: JsonWebKey }> | undefined;
function keys() {
  return (vapid ??= (async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = privateKey.export({ format: "jwk" });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    await db.query(`insert into push_vapid (id, public_key, private_key) values (1, $1, $2) on conflict (id) do nothing`, [
      pub.toString("base64url"),
      jwk,
    ]);
    const { rows } = await db.query<{ pub: string; jwk: JsonWebKey }>(
      `select public_key as pub, private_key as jwk from push_vapid where id = 1`,
    );
    return rows[0];
  })().catch((e) => {
    vapid = undefined;
    throw e;
  }));
}

export const pushKey = async () => ({ key: (await keys()).pub });

function endpointOk(x: unknown): x is string {
  if (typeof x !== "string" || x.length > 1000) return false;
  try {
    const u = new URL(x);
    return u.protocol === "https:" && PUSH_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

// This browser can get reminders for the signed-in person (a browser someone else used becomes theirs).
export async function addDevice(b: Record<string, unknown>) {
  const { user } = await who();
  const k = (b.keys ?? {}) as Record<string, unknown>;
  if (!endpointOk(b.endpoint) || typeof k.p256dh !== "string" || !KEY.test(k.p256dh) || typeof k.auth !== "string" || !AUTH.test(k.auth))
    throw bad("This browser's push details don't look right.");
  const { rows: n } = await db.query<{ n: number }>(`select count(*)::int as n from push_device where user_id = $1`, [user]);
  if (n[0].n >= MAX_DEVICES) throw bad(`Reminders can be on for up to ${MAX_DEVICES} browsers. Turn one off first.`);
  const { rows } = await db.query<{ id: string }>(
    `insert into push_device (id, user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4, $5)
     on conflict (endpoint) do update set user_id = $2, p256dh = $4, auth = $5
     returning id`,
    [randomUUID(), user, b.endpoint, k.p256dh, k.auth],
  );
  return { id: rows[0].id };
}

export async function removeDevice(endpoint: unknown) {
  const { user } = await who();
  await db.query(`delete from push_device where endpoint = $1 and user_id = $2`, [String(endpoint), user]);
  return { ok: true };
}

// Every browser with reminders on, with the public keys the app seals reminders for.
export async function devices() {
  const { user } = await who();
  const { rows } = await db.query<{ id: string; p256dh: string; auth: string }>(
    `select id, p256dh, auth from push_device where user_id = $1 order by created_at`,
    [user],
  );
  return rows;
}

// A browser's sealed reminders for this workspace, replacing the ones planned before.
export async function setNotes(device: string, b: Record<string, unknown>) {
  const { user, workspace } = await who();
  const notes = b.notes;
  const now = Date.now();
  if (
    !Array.isArray(notes) ||
    notes.length > MAX_NOTES ||
    !notes.every(
      (n) =>
        n &&
        typeof n.at === "number" &&
        n.at > now - 5 * 60_000 &&
        n.at < now + 8 * 86_400_000 &&
        typeof n.body === "string" &&
        n.body.length <= 6000 &&
        /^[\w-]+$/.test(n.body),
    )
  )
    throw bad("Those reminders don't look right.");
  const c = await db.connect();
  try {
    await c.query("begin");
    const { rowCount } = await c.query(`select 1 from push_device where id = $1 and user_id = $2 for update`, [device, user]);
    if (!rowCount) throw new ApiError(404, "That browser's reminders are off.");
    await c.query(`delete from push_note where device_id = $1 and workspace = $2`, [device, workspace]);
    if (notes.length)
      await c.query(
        `insert into push_note (device_id, workspace, send_at, body)
         select $1, $2, to_timestamp(a / 1000.0), decode(translate(b, '-_', '+/') || repeat('=', (4 - length(b) % 4) % 4), 'base64')
         from unnest($3::float8[], $4::text[]) as x(a, b)`,
        [device, workspace, notes.map((n) => n.at), notes.map((n) => n.body)],
      );
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  return { ok: true };
}

async function vapidHeader(endpoint: string) {
  const { pub, jwk } = await keys();
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUBJECT,
  })}`;
  const sig = sign("sha256", Buffer.from(head), { key: createPrivateKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${sig.toString("base64url")}, k=${pub}`;
}

// Hands what's due to the push services. Taking a row deletes it, so two servers never send one twice.
export async function sendDue() {
  const { rows } = await db.query<{ id: string; endpoint: string; body: Buffer; late: boolean }>(
    `with due as (delete from push_note where send_at <= now() returning device_id, body, send_at)
     select d.id, d.endpoint, due.body, due.send_at < now() - interval '1 hour' as late
     from due join push_device d on d.id = due.device_id`,
  );
  await Promise.all(
    rows
      .filter((r) => !r.late) // a reminder an hour late is noise (the server was down)
      .map(async (r) => {
        const res = await fetch(r.endpoint, {
          method: "POST",
          headers: {
            authorization: await vapidHeader(r.endpoint),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: "3600",
            urgency: "high",
          },
          body: new Uint8Array(r.body),
        }).catch((e) => (console.error("push", e), null));
        // Gone: the browser turned notifications off or was reset.
        if (res?.status === 404 || res?.status === 410) await db.query(`delete from push_device where id = $1`, [r.id]);
        else if (res && !res.ok) console.error("push", res.status, await res.text().catch(() => ""));
      }),
  );
  return rows.length;
}
