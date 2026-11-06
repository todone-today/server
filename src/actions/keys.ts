// Zero knowledge: the server stores keys it can't open and checks a hash it can't reverse. The browser derives
// everything from the password (see @todone/sdk/crypto); here we only store, hand back, and swap atomically.
import { createHmac } from "node:crypto";
import { ApiError, bad, requestHeaders } from "../context.ts";
import { auth } from "../lib/auth.ts";
import { db } from "../lib/db.ts";

const ITER = 600_000;
const BLOB = /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;
const B64 = /^[A-Za-z0-9+/=]{16,1200}$/;

export type Keys = {
  kdfSalt: string;
  kdfIter: number;
  wrappedKey: string;
  recoveryWrappedKey: string;
  encryptedRecovery: string;
  publicKey: string;
  wrappedPrivateKey: string;
};

// Checks what a browser sends before it's stored: well-formed, sensible sizes, nothing else.
function keysFrom(b: Record<string, unknown>, only?: (keyof Keys)[]): Partial<Keys> {
  const out: Partial<Keys> = {};
  const fields =
    only ??
    ([
      "kdfSalt",
      "kdfIter",
      "wrappedKey",
      "recoveryWrappedKey",
      "encryptedRecovery",
      "publicKey",
      "wrappedPrivateKey",
    ] as const);
  for (const f of fields) {
    const v = b[f];
    if (f === "kdfIter") {
      if (!Number.isInteger(v) || (v as number) < 100_000 || (v as number) > 10_000_000) throw bad("Bad key settings");
      out.kdfIter = v as number;
    } else if (typeof v !== "string" || !(f === "kdfSalt" || f === "publicKey" ? B64 : BLOB).test(v) || v.length > 4000)
      throw bad("Bad key data");
    else out[f] = v;
  }
  return out;
}
const authHashFrom = (v: unknown) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/=]{40,60}$/.test(v)) throw bad("Bad sign-in data");
  return v;
};

async function setPassword(client: { query: typeof db.query }, userId: string, authHash: string) {
  const hash = await (await auth.$context).password.hash(authHash);
  await client.query(
    `update account set password = $2, "updatedAt" = now() where "userId" = $1 and "providerId" = 'credential'`,
    [userId, hash],
  );
}
async function checkPassword(userId: string, password: string) {
  const { rows } = await db.query<{ password: string | null }>(
    `select password from account where "userId" = $1 and "providerId" = 'credential'`,
    [userId],
  );
  const ok = !!rows[0]?.password && (await (await auth.$context).password.verify({ hash: rows[0].password, password }));
  if (!ok) throw new ApiError(403, "That password isn't right.");
}
async function tx<T>(work: (c: { query: typeof db.query }) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const r = await work(c as unknown as { query: typeof db.query });
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const SET_KEYS = `"kdfSalt" = $2, "kdfIter" = $3, "wrappedKey" = $4, "recoveryWrappedKey" = $5, "encryptedRecovery" = $6,
  "publicKey" = $7, "wrappedPrivateKey" = $8, "updatedAt" = now()`;
const keyArgs = (k: Partial<Keys>) => [
  k.kdfSalt,
  k.kdfIter,
  k.wrappedKey,
  k.recoveryWrappedKey,
  k.encryptedRecovery,
  k.publicKey,
  k.wrappedPrivateKey,
];

async function session() {
  const s = await auth.api.getSession({ headers: requestHeaders() });
  if (!s) throw new ApiError(401, "Signed out");
  return s;
}

// Before signing in: how to derive this account's keys. Unknown emails get a made-up but stable salt, so this
// can't be used to find out who has an account. `legacy`: an account from before encryption (signs in once with
// its password, then sets up keys).
export async function prelogin(email: unknown) {
  if (typeof email !== "string" || email.length > 320) throw bad("Bad email");
  const e = email.trim().toLowerCase();
  const { rows } = await db.query<{ kdfSalt: string | null; kdfIter: number | null }>(
    `select "kdfSalt", "kdfIter" from "user" where lower(email) = $1`,
    [e],
  );
  if (rows[0] && !rows[0].kdfSalt) return { legacy: true };
  if (rows[0]) return { salt: rows[0].kdfSalt!, iterations: rows[0].kdfIter ?? ITER };
  const fake = createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "todone")
    .update(`salt:${e}`)
    .digest()
    .subarray(0, 16);
  return { salt: fake.toString("base64"), iterations: ITER };
}

// The signed-in person's wrapped keys and their teams' wrapped team keys.
export async function myKeys() {
  const s = await session();
  const { rows } = await db.query<Keys>(
    `select "kdfSalt", "kdfIter", "wrappedKey", "recoveryWrappedKey", "encryptedRecovery", "publicKey", "wrappedPrivateKey"
     from "user" where id = $1`,
    [s.user.id],
  );
  const teams = await db.query<{ organizationId: string; wrapped: string }>(
    `select k."organizationId", k.wrapped from org_key k
     join member m on m."organizationId" = k."organizationId" and m."userId" = k."userId"
     where k."userId" = $1`,
    [s.user.id],
  );
  return { ...rows[0], teamKeys: Object.fromEntries(teams.rows.map((r) => [r.organizationId, r.wrapped])) };
}

// An account from before encryption: prove the old password once, then the hash and keys replace it together.
export async function setupKeys(b: Record<string, unknown>) {
  const s = await session();
  const has = await db.query(`select 1 from "user" where id = $1 and "kdfSalt" is not null`, [s.user.id]);
  if (has.rowCount) throw bad("Keys are already set up");
  if (typeof b.password !== "string") throw bad("Missing password");
  await checkPassword(s.user.id, b.password);
  const authHash = authHashFrom(b.authHash);
  const k = keysFrom(b);
  await tx(async (c) => {
    await setPassword(c, s.user.id, authHash);
    await c.query(`update "user" set ${SET_KEYS} where id = $1`, [s.user.id, ...keyArgs(k)]);
  });
}

// Change password: the same account key, wrapped by the new password. Both swap at once, so nobody is locked out
// halfway; other devices are signed out.
export async function changePassword(b: Record<string, unknown>) {
  const s = await session();
  await checkPassword(s.user.id, authHashFrom(b.currentAuthHash));
  const authHash = authHashFrom(b.authHash);
  const k = keysFrom(b, ["kdfSalt", "kdfIter", "wrappedKey"]);
  await tx(async (c) => {
    await setPassword(c, s.user.id, authHash);
    await c.query(`update "user" set "kdfSalt" = $2, "kdfIter" = $3, "wrappedKey" = $4, "updatedAt" = now() where id = $1`, [
      s.user.id,
      k.kdfSalt,
      k.kdfIter,
      k.wrappedKey,
    ]);
    await c.query(`delete from session where "userId" = $1 and token <> $2`, [s.user.id, s.session.token]);
  });
}

// A new recovery key (the old one stops working). Needs the password, like any change to how the account opens.
export async function newRecoveryKey(b: Record<string, unknown>) {
  const s = await session();
  await checkPassword(s.user.id, authHashFrom(b.currentAuthHash));
  const k = keysFrom(b, ["recoveryWrappedKey", "encryptedRecovery"]);
  await db.query(
    `update "user" set "recoveryWrappedKey" = $2, "encryptedRecovery" = $3, "updatedAt" = now() where id = $1`,
    [s.user.id, k.recoveryWrappedKey, k.encryptedRecovery],
  );
}

// Forgot password, step 2 (after the emailed link): the person behind a valid reset token gets their
// recovery-wrapped key, which only their recovery key opens.
async function resetUser(token: unknown) {
  if (typeof token !== "string" || !/^[\w-]{10,200}$/.test(token)) throw bad("Bad link");
  const { rows } = await db.query<{ value: string }>(
    `select value from verification where identifier = $1 and "expiresAt" > now()`,
    [`reset-password:${token}`],
  );
  if (!rows[0]) throw new ApiError(400, "This link has expired or was already used. Ask for a new one.");
  return { userId: rows[0].value, identifier: `reset-password:${token}` };
}
export async function recoveryFor(token: unknown) {
  const { userId } = await resetUser(token);
  const { rows } = await db.query<{ recoveryWrappedKey: string | null }>(
    `select "recoveryWrappedKey" from "user" where id = $1`,
    [userId],
  );
  return { recoveryWrappedKey: rows[0]?.recoveryWrappedKey ?? null };
}

// Forgot password, step 3 with the recovery key: new password, same data. All sessions end.
export async function recover(b: Record<string, unknown>) {
  const { userId, identifier } = await resetUser(b.token);
  const authHash = authHashFrom(b.authHash);
  const k = keysFrom(b, ["kdfSalt", "kdfIter", "wrappedKey"]);
  await tx(async (c) => {
    await setPassword(c, userId, authHash);
    await c.query(`update "user" set "kdfSalt" = $2, "kdfIter" = $3, "wrappedKey" = $4, "updatedAt" = now() where id = $1`, [
      userId,
      k.kdfSalt,
      k.kdfIter,
      k.wrappedKey,
    ]);
    await c.query(`delete from verification where identifier = $1`, [identifier]);
    await c.query(`delete from session where "userId" = $1`, [userId]);
  });
}

// Forgot password without the recovery key: the login stays, everything encrypted goes (nobody can open it).
// Lists switched off encryption survive; team keys must be given again by a teammate.
export async function resetAccount(b: Record<string, unknown>) {
  const { userId, identifier } = await resetUser(b.token);
  const authHash = authHashFrom(b.authHash);
  const k = keysFrom(b);
  await tx(async (c) => {
    await setPassword(c, userId, authHash);
    await c.query(`update "user" set ${SET_KEYS} where id = $1`, [userId, ...keyArgs(k)]);
    await c.query(`delete from list where "userId" = $1 and data is not null`, [userId]);
    await c.query(`delete from org_key where "userId" = $1`, [userId]);
    await c.query(`delete from verification where identifier = $1`, [identifier]);
    await c.query(`delete from session where "userId" = $1`, [userId]);
  });
}

// Teams: who's in it, their public keys, and who still needs the team key.
async function memberOf(userId: string, org: string) {
  const m = await db.query(`select 1 from member where "userId" = $1 and "organizationId" = $2`, [userId, org]);
  if (!m.rowCount) throw new ApiError(403, "Not a member");
}
export async function teamKeys(org: string) {
  const s = await session();
  await memberOf(s.user.id, org);
  const { rows } = await db.query<{
    userId: string;
    name: string;
    email: string;
    publicKey: string | null;
    hasKey: boolean;
  }>(
    `select m."userId", u.name, u.email, u."publicKey", (k."userId" is not null) as "hasKey"
     from member m join "user" u on u.id = m."userId"
     left join org_key k on k."organizationId" = m."organizationId" and k."userId" = m."userId"
     where m."organizationId" = $1`,
    [org],
  );
  return rows;
}

// Hands the team key to members (wrapped to each one's public key). Only someone who holds it can give it, or
// anyone in a team that has no key yet (the first one). Existing keys are never overwritten.
export async function giveTeamKeys(org: string, given: unknown) {
  const s = await session();
  await memberOf(s.user.id, org);
  if (!Array.isArray(given) || given.length > 200) throw bad("Bad keys");
  const held = await db.query<{ userId: string }>(`select "userId" from org_key where "organizationId" = $1`, [org]);
  const holders = new Set(held.rows.map((r) => r.userId));
  const first = holders.size === 0;
  if (!first && !holders.has(s.user.id)) throw new ApiError(403, "Only a teammate who has the team key can give it");
  if (first && !given.some((g) => g?.userId === s.user.id)) throw bad("The first key must include your own");
  for (const g of given as { userId?: unknown; wrapped?: unknown }[]) {
    if (typeof g.userId !== "string" || typeof g.wrapped !== "string" || !B64.test(g.wrapped)) throw bad("Bad key");
    await db.query(
      `insert into org_key ("organizationId", "userId", wrapped)
       select $1, $2, $3 where exists (select 1 from member where "organizationId" = $1 and "userId" = $2)
       on conflict do nothing`,
      [org, g.userId, g.wrapped],
    );
  }
}
