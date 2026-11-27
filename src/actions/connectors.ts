import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ApiError, later } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";

// AI apps on someone's own computer (the todone-mcp connector), connected from Account. Each person has one code
// for all their AI apps, shown again whenever they ask, and replaced when they ask for a new one (the old one then
// stops working). It's kept readable so it can be shown again: it opens only lists made readable, which this server
// can read anyway. Connections made before (one per app, kept as a hash only) keep working until a new code.

// The connector making this request, once its token checked out (app.ts).
export const connectorAuth = new AsyncLocalStorage<{ id: string; user: string }>();

export const TOKEN = /^tdn_[A-Za-z0-9_-]{32,64}$/;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// What a connector may do: read and save lists, and see its workspaces. It holds no key, so it can only read and
// write readable lists. Nothing that changes the account (keys, password, billing, sharing, other connections).
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/api\/lists$/],
  ["POST", /^\/api\/lists$/],
  ["PUT", /^\/api\/lists\/(?!order$)[\w-]+$/],
  ["DELETE", /^\/api\/lists\/[\w-]+$/],
  ["GET", /^\/api\/connectors\/self$/],
  ["GET", /^\/api\/workspaces$/],
];
export const connectorMay = (method: string, path: string) => ALLOWED.some(([m, p]) => m === method && p.test(path));

const fresh = () => `tdn_${randomBytes(32).toString("base64url")}`;
async function insert(user: string) {
  const token = fresh();
  await db.query(`insert into connector (id, user_id, name, token_hash, token) values ($1, $2, 'AI apps', $3, $4)`, [
    randomUUID(),
    user,
    hashToken(token),
    token,
  ]);
  return token;
}
const lastUsed = async (user: string) => {
  const { rows } = await db.query<{ used: Date | null }>(`select max(last_used_at) as used from connector where user_id = $1`, [user]);
  return rows[0]?.used ? +rows[0].used : null;
};

// The person's code (made the first time), and when an AI app last used todone.
export async function code() {
  const { user } = await who();
  const { rows } = await db.query<{ token: string }>(
    `select token from connector where user_id = $1 and token is not null order by created_at desc limit 1`,
    [user],
  );
  return { code: rows[0]?.token ?? (await insert(user)), used: await lastUsed(user) };
}

// A new code: every earlier one stops working.
export async function newCode() {
  const { user } = await who();
  await db.query(`delete from connector where user_id = $1`, [user]);
  return { code: await insert(user), used: null };
}

// The connector asking who it is (the name it was given and whose account).
export async function self() {
  const c = connectorAuth.getStore();
  if (!c) throw new ApiError(403, "Only an AI app can ask this.");
  const { rows } = await db.query<{ name: string }>(
    `select name from connector where id = $1`,
    [c.id],
  );
  if (!rows[0]) throw new ApiError(401, "This todone code was replaced with a new one.");
  return { name: rows[0].name, user: c.user };
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
