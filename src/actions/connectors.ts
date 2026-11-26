import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { ApiError, bad, later } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";

// AI apps on someone's own computer (the todone-mcp connector), connected from Account. The browser makes the
// connection code: a token, which signs the connector in (only its hash is kept here), and a secret, which never
// reaches the server and unwraps the account key the browser left here wrapped to it. So the connector opens the
// lists on that computer and they stay end-to-end encrypted.

// The connector making this request, once its token checked out (app.ts).
export const connectorAuth = new AsyncLocalStorage<{ id: string; user: string }>();

export const TOKEN = /^tdn_[A-Za-z0-9_-]{32,64}$/;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// What a connector may do: read and save lists, and fetch the keys and workspaces to open them. Nothing that
// changes the account (keys, password, billing, sharing, other connections).
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/api\/lists$/],
  ["POST", /^\/api\/lists$/],
  ["PUT", /^\/api\/lists\/(?!order$)[\w-]+$/],
  ["DELETE", /^\/api\/lists\/[\w-]+$/],
  ["GET", /^\/api\/keys$/],
  ["GET", /^\/api\/connectors\/self$/],
  ["GET", /^\/api\/workspaces$/],
];
export const connectorMay = (method: string, path: string) => ALLOWED.some(([m, p]) => m === method && p.test(path));

const MAX = 10;
const BLOB = /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;
type Row = { id: string; name: string; created_at: Date; last_used_at: Date | null };
const shape = (r: Row) => ({ id: r.id, name: r.name, created: +r.created_at, used: r.last_used_at ? +r.last_used_at : null });

export async function create(b: Record<string, unknown>) {
  const { user } = await who();
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 60) throw bad("Give it a name of up to 60 characters.");
  if (typeof b.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(b.tokenHash)) throw bad("Invalid connection");
  if (typeof b.wrappedKey !== "string" || b.wrappedKey.length > 200 || !BLOB.test(b.wrappedKey)) throw bad("Invalid connection");
  const n = await db.query(`select 1 from connector where user_id = $1`, [user]);
  if ((n.rowCount ?? 0) >= MAX) throw bad(`You can have ${MAX} connections. Remove one you don't use first.`);
  const { rows } = await db.query<Row>(
    `insert into connector (id, user_id, name, token_hash, wrapped_key) values ($1, $2, $3, $4, $5)
     returning id, name, created_at, last_used_at`,
    [randomUUID(), user, name, b.tokenHash, b.wrappedKey],
  );
  return shape(rows[0]);
}

export async function mine() {
  const { user } = await who();
  const { rows } = await db.query<Row>(
    `select id, name, created_at, last_used_at from connector where user_id = $1 order by created_at`,
    [user],
  );
  return rows.map(shape);
}

export async function remove(id: string) {
  const { user } = await who();
  await db.query(`delete from connector where id = $1 and user_id = $2`, [id, user]);
  return { ok: true };
}

// The connector asking for its own wrapped key (and the name it was given).
export async function self() {
  const c = connectorAuth.getStore();
  if (!c) throw new ApiError(403, "Only a connection can ask this.");
  const { rows } = await db.query<{ name: string; wrapped_key: string }>(
    `select name, wrapped_key from connector where id = $1`,
    [c.id],
  );
  if (!rows[0]) throw new ApiError(401, "This connection was removed.");
  return { name: rows[0].name, wrappedKey: rows[0].wrapped_key, user: c.user };
}

// Who a token belongs to (null: unknown or removed). Notes when it was last used, at most once a minute.
export async function byToken(token: string) {
  const { rows } = await db.query<{ id: string; user_id: string; last_used_at: Date | null }>(
    `select id, user_id, last_used_at from connector where token_hash = $1`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  if (!r.last_used_at || Date.now() - +r.last_used_at > 60_000)
    later(() => db.query(`update connector set last_used_at = now() where id = $1`, [r.id]));
  return { id: r.id, user: r.user_id };
}

// The person's workspaces: their own, and each team they're in.
export async function workspaces() {
  const { user } = await who();
  const { rows } = await db.query<{ id: string; name: string }>(
    `select o.id, o.name from member m join organization o on o.id = m."organizationId" where m."userId" = $1 order by o.name`,
    [user],
  );
  return [{ id: "personal", name: "Personal" }, ...rows];
}
