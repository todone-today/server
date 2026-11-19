import { timingSafeEqual } from "node:crypto";
import { db } from "../lib/db.ts";
import { FOUNDING, MONTHS, PRICE } from "../lib/plans.ts";

// Counts for the production dashboard (Grafana), read with STATS_TOKEN. Totals and per-day counts only: never a
// name, an email, an id or anything anyone wrote. Off (404) without the token set. Days are India time (IST).
const TOKEN = process.env.STATS_TOKEN ?? "";
export const hasStats = TOKEN.length >= 32;

export function statsAllowed(header: string | undefined) {
  const given = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return hasStats && given.length === want.length && timingSafeEqual(given, want);
}

const DAY = `(now() at time zone 'Asia/Kolkata')::date`;
const days = (n: number) => `(select g::date as d from generate_series(${DAY} - ${n - 1}, ${DAY}, interval '1 day') g) s`;

// Monthly recurring revenue, in rupees: each paid-up plan's price spread over its months. A first term bought at the
// launch price counts at what was paid; Founding counts its one payment over its 36 months.
export const monthly = (s: { plan: "plus" | "team"; term: string; seats: number; upfront: number; intro: boolean; renewed: boolean }) =>
  s.term === "founding"
    ? FOUNDING.amount / FOUNDING.months
    : (s.intro && !s.renewed ? s.upfront : PRICE[s.plan][s.term as "month"] * s.seats) / MONTHS[s.term as "month"];

export async function stats() {
  const [users, subs, signups, active, revenue] = await Promise.all([
    db.query<{ total: number; today: number; verified: number }>(
      `select count(*)::int total,
              count(*) filter (where ("createdAt" at time zone 'Asia/Kolkata')::date = ${DAY})::int today,
              count(*) filter (where "emailVerified")::int verified
         from "user"`,
    ),
    db.query<{ user_id: string; plan: "plus" | "team"; term: string; seats: number; upfront: number; intro: boolean; renewed: boolean }>(
      `select s.user_id, s.plan, s.term, s.seats, s.upfront, s.intro,
              (select count(*) from billing_payment p where p.sub_id = s.id) > 1 renewed
         from billing_sub s
        where s.paid_until > now() and s.status not in ('refunded', 'created')`,
    ),
    db.query<{ day: string; n: number }>(
      `select d::text as day, (select count(*) from "user" where ("createdAt" at time zone 'Asia/Kolkata')::date = d)::int n
         from ${days(90)} order by d`,
    ),
    db.query<{ day: string; n: number | null }>(
      // Days before active-user tracking began are null (unknown), not zero.
      `select d::text as day,
              case when d >= (select min(day) from active_day) then (select count(*) from active_day a where a.day = d)::int end n
         from ${days(90)} order by d`,
    ),
    db.query<{ day: string; inr: number }>(
      `select d::text as day,
              coalesce((select sum(amount - refunded) from billing_payment p
                         where (p.created_at at time zone 'Asia/Kolkata')::date = d), 0)::int / 100 inr
         from ${days(90)} order by d`,
    ),
  ]);
  const paying = new Set(subs.rows.map((s) => s.user_id)).size;
  const u = users.rows[0];
  return {
    at: new Date().toISOString(),
    users: u.total,
    signups_today: u.today,
    verified: u.verified,
    paying,
    free: u.total - paying,
    mrr_inr: Math.round(subs.rows.reduce((n, s) => n + monthly(s), 0) / 100),
    active_today: active.rows.at(-1)?.n ?? null,
    signups: signups.rows,
    active: active.rows,
    revenue: revenue.rows,
  };
}
