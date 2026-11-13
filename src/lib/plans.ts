// Plans, prices and limits, matching the pricing on the landing page (clients/apps/web/src/lib/landing.ts PLANS).
// Amounts are in paise. Limits only stop new things being made; nothing anyone has is ever locked or removed.
import { hasRazorpay } from "./razorpay.ts";

export type Paid = "plus" | "team";
export type Term = "month" | "half" | "year";
export type Level = "free" | Paid | "unlimited";
export const TERMS: Term[] = ["month", "half", "year"];
export const MONTHS: Record<Term, number> = { month: 1, half: 6, year: 12 };
export const PRICE: Record<Paid, Record<Term, number>> = {
  plus: { month: 9_900, half: 49_900, year: 89_900 },
  team: { month: 14_900, half: 79_900, year: 1_49_900 }, // a seat
};
// The launch price, for someone's first paid term only; it renews at PRICE. Only the first LAUNCH_SPOTS paid
// purchases (Plus and Team together) get it; after that, checkout charges PRICE.
export const LAUNCH_SPOTS = 100;
export const INTRO: Record<Paid, Partial<Record<Term, number>>> = {
  plus: { half: 34_900, year: 59_900 },
  team: { half: 54_900, year: 99_900 },
};
// Founding member: three years of Plus, paid once.
export const FOUNDING = { amount: 1_99_900, months: 36 };

export const FREE_LISTS = 10;
export const PLUS_PEOPLE = 6; // other people across the teams a Plus member owns
export const MAX_SEATS = 500;
const DAY = 86_400_000;
export const GRACE = 3 * DAY; // while Razorpay retries a failed renewal
export const REFUND_DAYS = 7;

// Accounts made before paid plans launched keep everything, free. Both must be set for billing to be on.
const START = Date.parse(process.env.BILLING_START ?? "");
export const billingOn = hasRazorpay && !Number.isNaN(START);
export const grandfathered = (createdAt: Date) => +createdAt < START;

// A subscription or Founding purchase as stored (billing_sub).
export type Sub = {
  id: string;
  plan: Paid;
  term: Term | "founding";
  seats: number;
  status: string;
  paid_until: Date | null;
  start_at: Date | null;
  cancel_at_end: boolean;
};

const RANK: Record<Level, number> = { free: 0, plus: 1, team: 2, unlimited: 3 };
// What someone may do now: the best of what they've paid for (to its end, plus a little grace while a renewal is retried).
export function entitle(subs: Sub[], now: number, createdAt: Date): { level: Level; seats: number; sub: Sub | null } {
  if (!billingOn || grandfathered(createdAt)) return { level: "unlimited", seats: Infinity, sub: null };
  let best: { level: Level; seats: number; sub: Sub | null } = { level: "free", seats: 1, sub: null };
  for (const s of subs) {
    if (!s.paid_until || +s.paid_until + (s.status === "refunded" ? 0 : GRACE) <= now) continue;
    if (RANK[s.plan] > RANK[best.level] || (s.plan === best.level && s.seats > best.seats))
      best = { level: s.plan, seats: s.plan === "team" ? s.seats : 1, sub: s };
  }
  return best;
}

// One term's regular price, and what it's worth a day (to weigh one plan against another).
export const termPrice = (plan: Paid, term: Term, seats: number) => PRICE[plan][term] * seats;
export const perDay = (s: Pick<Sub, "plan" | "term" | "seats">) =>
  s.term === "founding" ? FOUNDING.amount / (FOUNDING.months * 30.44) : termPrice(s.plan, s.term, s.seats) / (MONTHS[s.term] * 30.44);

// A better plan (Plus → Team, or more seats) starts now and costs the difference for the days already paid for. Anything
// else (fewer seats, Team → Plus, another term) waits for the current one to end. Never below ₹1, Razorpay's minimum.
export function upgradeCost(from: Sub, to: Pick<Sub, "plan" | "term" | "seats">, now: number) {
  const better = RANK[to.plan] > RANK[from.plan] || (to.plan === from.plan && to.seats > from.seats);
  if (!better) return 0;
  const days = Math.max(0, (+from.paid_until! - now) / DAY);
  const diff = (perDay(to) - perDay(from)) * days;
  return Math.max(100, Math.round(diff / 100) * 100); // whole rupees; a better plan applies now, so it charges something
}
