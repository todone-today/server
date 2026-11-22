// A goal shared by link. Goals are end-to-end encrypted, so the owner's app publishes a readable copy (the snapshot)
// after they agree to, and keeps it up to date as they log progress. "view" links are free: anyone can see the goal
// and make one like it. "challenge" links need Plus: up to 6 people join, each with their own copy of the goal, and
// everyone's progress shows on the page. A brand-new account that joins through a challenge is a referral, counted
// once its first real check-in arrives.
import { randomBytes } from "node:crypto";
import { ApiError, bad } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { mayShare } from "./billing.ts";

export const MAX_PEOPLE = 6; // the owner and up to 5 who join
const KINDS = ["habit", "outcome", "target", "daily"];

export type Snapshot = {
  title: string;
  kind: string;
  unit?: string;
  start?: number;
  target?: number;
  perWeek?: number;
  by?: string;
  current?: number;
  towards: number; // 0–1
  thisWeek: number;
  weeks: number[]; // the last 8 weeks, oldest first
  done?: number;
  total?: number;
  reached?: boolean;
  reward?: string;
};

const num = (x: unknown, lo = -1e9, hi = 1e9) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined);
const text = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
// Only these fields, each checked and cut to size: what the browser sends is published as is, so nothing else gets in.
export function snapshot(x: unknown): Snapshot {
  const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const title = text(s.title, 120);
  if (!title || !KINDS.includes(s.kind as string)) throw bad("That goal can't be shared as it is.");
  const weeks = Array.isArray(s.weeks) ? s.weeks.slice(-8).map((n) => num(n, 0, 1000) ?? 0) : [];
  const out: Snapshot = { title, kind: s.kind as string, towards: num(s.towards, 0, 1) ?? 0, thisWeek: num(s.thisWeek, 0, 1000) ?? 0, weeks };
  const unit = text(s.unit, 20);
  if (unit) out.unit = unit;
  for (const k of ["start", "target", "current", "done", "total"] as const) {
    const v = num(s[k]);
    if (v !== undefined) out[k] = v;
  }
  const perWeek = num(s.perWeek, 1, 7);
  if (perWeek) out.perWeek = perWeek;
  if (typeof s.by === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.by)) out.by = s.by;
  if (s.reached === true) out.reached = true;
  const reward = text(s.reward, 80);
  if (reward) out.reward = reward;
  return out;
}

// Short, readable, hard to guess: "run-5k-k3x9q2".
const slugFor = (title: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "goal"}-${randomBytes(5).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "")}`;

// Share (or re-share) a goal. One link per goal: sharing again keeps the link and updates what it shows.
export async function share(goal: unknown, mode: unknown, snap: unknown) {
  const { user, org, workspace } = await who();
  if (typeof goal !== "string" || !/^[\w-]{8,64}$/.test(goal)) throw bad("Bad goal");
  if (mode !== "view" && mode !== "challenge") throw bad("Bad mode");
  if (mode === "challenge") await mayShare(user, org);
  const s = snapshot(snap);
  const { rows } = await db.query<{ id: string }>(
    `insert into goal_share (id, workspace, owner, goal, mode, snapshot) values ($1, $2, $3, $4, $5, $6)
     on conflict (owner, goal) do update set snapshot = $6, updated_at = now(),
       mode = case when goal_share.mode = 'challenge' then 'challenge' else $5 end
     returning id`,
    [slugFor(s.title), workspace, user, goal, mode, JSON.stringify(s)],
  );
  return { slug: rows[0].id };
}

// The goals this person shared, and the challenges they joined: their app keeps each copy up to date.
export async function mine() {
  const { user } = await who();
  const own = await db.query<{ slug: string; goal: string; mode: string }>(
    `select id as slug, goal, mode from goal_share where owner = $1`,
    [user],
  );
  const joined = await db.query<{ slug: string; goal: string }>(
    `select share_id as slug, goal from goal_participant where user_id = $1`,
    [user],
  );
  return { own: own.rows, joined: joined.rows };
}

// A new copy of one goal's progress: the owner's (on the share), or a joiner's (on their row). A joiner's first
// check-in (anything done this week) activates the referral that brought them.
export async function update(slug: string, snap: unknown) {
  const { user } = await who();
  const s = snapshot(snap);
  const own = await db.query(`update goal_share set snapshot = $3, updated_at = now() where id = $1 and owner = $2`, [
    slug,
    user,
    JSON.stringify(s),
  ]);
  if (own.rowCount) return { ok: true };
  const p = await db.query<{ first: Date | null }>(
    `update goal_participant set snapshot = $3, updated_at = now(),
       first_checkin_at = coalesce(first_checkin_at, case when $4 then now() end)
     where share_id = $1 and user_id = $2 returning first_checkin_at as first`,
    [slug, user, JSON.stringify(s), s.thisWeek > 0 || s.weeks.some((n) => n > 0)],
  );
  if (!p.rowCount) throw new ApiError(404, "Not shared");
  if (p.rows[0].first)
    await db.query(`update referral set activated_at = coalesce(activated_at, now()) where invitee = $1 and share_id = $2`, [
      user,
      slug,
    ]);
  return { ok: true };
}

// Stop sharing: the link stops working, and anyone who joined keeps their own copy of the goal.
export async function unshare(slug: string) {
  const { user } = await who();
  await db.query(`delete from goal_share where id = $1 and owner = $2`, [slug, user]);
  return { ok: true };
}

// Leave a challenge you joined (your copy of the goal stays yours).
export async function leave(slug: string) {
  const { user } = await who();
  await db.query(`delete from goal_participant where share_id = $1 and user_id = $2`, [slug, user]);
  return { ok: true };
}

// The public page's data: the goal, its owner's name and picture (from their account, not from the browser), and in a
// challenge everyone else who joined. Names are first names only.
export async function view(slug: string) {
  const { rows } = await db.query<{ mode: string; snapshot: Snapshot; name: string; image: string | null; updated_at: Date }>(
    `select g.mode, g.snapshot, u.name, u.image, g.updated_at from goal_share g join "user" u on u.id = g.owner where g.id = $1`,
    [slug],
  );
  const g = rows[0];
  if (!g) throw new ApiError(404, "This link was turned off, or never existed.");
  const first = (n: string | null) => (n ?? "").trim().split(/\s+/)[0] || "Someone";
  const people =
    g.mode === "challenge"
      ? (
          await db.query<{ name: string; image: string | null; snapshot: Snapshot }>(
            `select u.name, u.image, p.snapshot from goal_participant p join "user" u on u.id = p.user_id
             where p.share_id = $1 order by p.joined_at`,
            [slug],
          )
        ).rows.map((p) => ({ name: first(p.name), image: p.image, snapshot: p.snapshot }))
      : [];
  return {
    mode: g.mode,
    owner: { name: first(g.name), image: g.image },
    snapshot: g.snapshot,
    people,
    spots: g.mode === "challenge" ? Math.max(0, MAX_PEOPLE - 1 - people.length) : 0,
    updated: g.updated_at,
  };
}

// Join a challenge with your own copy of the goal (`goal`, its id in your own list). A new account (made after the
// challenge was shared, within the last 7 days, email confirmed, not the owner's) that joins becomes a referral.
export async function join(slug: string, goal: unknown) {
  const { user } = await who();
  if (typeof goal !== "string" || !/^[\w-]{8,64}$/.test(goal)) throw bad("Bad goal");
  const { rows } = await db.query<{ owner: string; mode: string; created_at: Date }>(
    `select owner, mode, created_at from goal_share where id = $1`,
    [slug],
  );
  const g = rows[0];
  if (!g || g.mode !== "challenge") throw new ApiError(404, "This challenge isn't open.");
  if (g.owner === user) throw bad("That's your own challenge.");
  const n = await db.query<{ n: number }>(`select count(*)::int as n from goal_participant where share_id = $1`, [slug]);
  if (n.rows[0].n >= MAX_PEOPLE - 1) throw bad(`This challenge is full (${MAX_PEOPLE} people).`);
  await db.query(
    `insert into goal_participant (share_id, user_id, goal) values ($1, $2, $3)
     on conflict (share_id, user_id) do update set goal = $3`,
    [slug, user, goal],
  );
  await db.query(
    `insert into referral (invitee, inviter, share_id)
     select $1, $2, $3 from "user" u
     where u.id = $1 and u."emailVerified" and u."createdAt" > $4 and u."createdAt" > now() - interval '7 days'
     on conflict (invitee) do nothing`,
    [user, g.owner, slug, g.created_at],
  );
  return { ok: true };
}
