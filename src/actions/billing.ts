// Paid plans with Razorpay. Plus and Team are auto-renewing subscriptions; Founding is one order for three years.
//
// Every purchase is a subscription that starts at a future date with an upfront amount paid now (Razorpay's
// "start_at" + "addons"), which covers the time until then:
//   - first purchase: starts after one term, upfront = the launch price (or the price): the term is paid at once;
//   - upgrade (worth more a day): starts when the current one ends, upfront = the difference for the days left;
//   - anything else: starts when the current one ends, nothing now.
// The one it replaces is cancelled at its cycle end. Plans are never "updated" in place, which Razorpay refuses for
// UPI. Limits (lib/plans.ts) only ever stop new things being made.
import { APIError } from "better-auth/api";
import { ApiError, bad, needsPlan } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import {
  FOUNDING,
  FREE_LISTS,
  INTRO,
  LAUNCH_SPOTS,
  MAX_SEATS,
  MONTHS,
  PLUS_PEOPLE,
  PRICE,
  REFUND_DAYS,
  TERMS,
  billingOn,
  entitle,
  grandfathered,
  upgradeCost,
  type Paid,
  type Sub,
  type Term,
} from "../lib/plans.ts";
import { checkoutOk, keyId, rzp, webhookOk } from "../lib/razorpay.ts";

const DAY = 86_400_000;
const NAME: Record<Paid, string> = { plus: "Plus", team: "Team" };
const TERM_NAME: Record<Term | "founding", string> = { month: "monthly", half: "6 months", year: "yearly", founding: "Founding member" };
const addMonths = (t: number, n: number) => {
  const d = new Date(t);
  d.setMonth(d.getMonth() + n);
  return +d;
};
const unix = (t: number) => Math.floor(t / 1000);

type Person = { id: string; email: string; name: string; createdAt: Date };
async function person(id: string): Promise<Person> {
  const { rows } = await db.query<Person>(`select id, email, name, "createdAt" from "user" where id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "No such account");
  return rows[0];
}
const subsOf = (user: string) =>
  db
    .query<Sub & { upfront: number; created_at: Date }>(`select * from billing_sub where user_id = $1 order by created_at`, [user])
    .then((r) => r.rows);

export async function levelOf(user: string) {
  const [p, subs] = await Promise.all([person(user), subsOf(user)]);
  return entitle(subs, Date.now(), p.createdAt);
}

// Who pays for a workspace: the person, or a team's (first) owner.
async function payer(user: string, org: string | null) {
  if (!org) return user;
  const { rows } = await db.query<{ userId: string }>(
    `select "userId" from member where "organizationId" = $1 and role = 'owner' order by "createdAt" limit 1`,
    [org],
  );
  return rows[0]?.userId ?? user;
}

// Other people in the teams someone owns, counting invitations still open.
async function peopleOf(owner: string) {
  const { rows } = await db.query<{ n: number }>(
    `with mine as (select "organizationId" from member where "userId" = $1 and role = 'owner')
     select (select count(distinct m."userId") from member m where m."organizationId" in (select * from mine) and m."userId" <> $1)::int
          + (select count(distinct lower(i.email)) from invitation i
             where i."organizationId" in (select * from mine) and i.status = 'pending'
               and lower(i.email) not in (select lower(u.email) from member m join "user" u on u.id = m."userId"
                                          where m."organizationId" in (select * from mine)))::int as n`,
    [owner],
  );
  return rows[0].n;
}
const peopleLimit = (level: string, seats: number) =>
  level === "unlimited" ? Infinity : level === "team" ? seats - 1 : level === "plus" ? PLUS_PEOPLE : 0;

const listCount = (user: string) =>
  db
    .query<{ n: number }>(`select count(*)::int n from list where "userId" = $1 and kind = 'list'`, [user])
    .then((r) => r.rows[0].n);

// ---- The gates ----

export async function mayAddList(user: string, org: string | null, kind: unknown) {
  if (!billingOn || org || kind !== "list") return;
  if ((await levelOf(user)).level === "free" && (await listCount(user)) >= FREE_LISTS)
    throw needsPlan(`Free holds ${FREE_LISTS} lists. Plus has as many as you need.`);
}
export async function mayShare(user: string, org: string | null) {
  if (!billingOn) return;
  if ((await levelOf(await payer(user, org))).level === "free")
    throw needsPlan(org ? "Sharing needs the team's owner on Plus or Team." : "Sharing comes with Plus.");
}
export async function mayMakeTeam(user: string) {
  return !billingOn || (await levelOf(user)).level !== "free";
}
// Better Auth hook: before an invitation goes out. The team's owner pays for the people in it.
export async function mayInvite(org: string, inviter: string) {
  if (!billingOn) return;
  const owner = await payer(inviter, org);
  const { level, seats } = await levelOf(owner);
  const limit = peopleLimit(level, seats);
  if ((await peopleOf(owner)) + 1 > limit)
    throw new APIError("FORBIDDEN", {
      message:
        level === "team"
          ? `All ${seats} seats are taken. The owner can add seats in Account → Plan.`
          : level === "plus"
            ? `Plus shares with up to ${PLUS_PEOPLE} people. Team has room for everyone.`
            : "Teams come with Plus.",
    });
}

// ---- The launch price: the first LAUNCH_SPOTS paid purchases ----

// Spots left: purchases at the launch price that were paid and not refunded (one per person) count as taken.
// ponytail: two people paying for the last spot at the same moment can both get it; fine at 100, lock if it matters.
export async function launchLeft() {
  const { rows } = await db.query<{ n: number }>(
    `select count(distinct user_id)::int as n from billing_sub where intro and paid_until is not null and status <> 'refunded'`,
  );
  return Math.max(0, LAUNCH_SPOTS - (rows[0]?.n ?? 0));
}
export const launch = async () => ({ left: await launchLeft(), total: LAUNCH_SPOTS });

// ---- What someone sees in Account → Plan ----

export async function status() {
  const { user } = await who();
  const [p, subs] = await Promise.all([person(user), subsOf(user)]);
  const now = Date.now();
  const e = entitle(subs, now, p.createdAt);
  const { rows: payments } = await db.query(
    `select id, amount, refunded, what, invoice_no, created_at from billing_payment where user_id = $1 order by created_at desc`,
    [user],
  );
  const refundable = payments.find((x) => !x.refunded && now - +x.created_at < REFUND_DAYS * DAY);
  const left = await launchLeft();
  // What renews: the paid-for subscription that isn't cancelled, else one scheduled to start later.
  const live = subs.filter((s) => s.term !== "founding" && !s.cancel_at_end && ["active", "authenticated"].includes(s.status));
  const next = live.find((s) => s !== e.sub && s.start_at && +s.start_at > now);
  const [lists, people] = await Promise.all([listCount(user), peopleOf(user)]);
  return {
    on: billingOn,
    key: keyId,
    level: e.level,
    grandfathered: billingOn && grandfathered(p.createdAt),
    plan: e.sub && {
      plan: e.sub.plan,
      term: e.sub.term,
      seats: e.sub.seats,
      until: e.sub.paid_until,
      renews: live.includes(e.sub as (typeof live)[number]),
    },
    next: next && { plan: next.plan, term: next.term, seats: next.seats, from: next.start_at },
    intro: !payments.length && left > 0,
    launch: { left, total: LAUNCH_SPOTS },
    usage: { lists, listLimit: e.level === "free" ? FREE_LISTS : null, people, peopleLimit: Number.isFinite(peopleLimit(e.level, e.seats)) ? peopleLimit(e.level, e.seats) : null },
    prices: { price: PRICE, intro: INTRO, founding: FOUNDING.amount, months: MONTHS },
    payments,
    refundable: refundable?.id ?? null,
  };
}

// What a change would cost today (for the plan picker), without making anything.
export async function quote(b: Record<string, unknown>) {
  const { user } = await who();
  const to = choice(b);
  const [p, subs, left] = await Promise.all([person(user), subsOf(user), launchLeft(), enoughSeats(user, to)]);
  return plan(to, subs, p, Date.now(), left);
}

// Team needs a seat for everyone already in your teams (and invited), you included.
async function enoughSeats(user: string, to: { plan: Paid; seats: number }) {
  const need = (await peopleOf(user)) + 1;
  if (to.plan === "team" && to.seats < need) throw bad(`Your teams have ${need} people with invitations; pick at least ${need} seats.`);
}

function choice(b: Record<string, unknown>) {
  const plan = b.plan as Paid;
  const term = b.term as Term;
  const seats = plan === "team" ? Number(b.seats) : 1;
  if (!["plus", "team"].includes(plan) || !TERMS.includes(term) || !Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS)
    throw bad("Pick a plan, how often to pay, and the seats.");
  return { plan, term, seats };
}

// How a purchase works out: when the new subscription starts, and what's paid now.
function plan(to: { plan: Paid; term: Term; seats: number }, subs: Sub[], p: Person, now: number, left: number) {
  const cur = entitle(subs, now, p.createdAt).sub;
  const paidAhead = cur?.paid_until && +cur.paid_until > now ? cur : null;
  if (paidAhead) {
    const same = paidAhead.plan === to.plan && paidAhead.term === to.term && paidAhead.seats === to.seats;
    if (same && !paidAhead.cancel_at_end) throw bad("That's the plan you have.");
    const now$ = same ? 0 : upgradeCost(paidAhead, to, now);
    return { ...to, upfront: now$, startAt: +paidAhead.paid_until!, upgrade: now$ > 0, intro: false };
  }
  const first = !subs.some((s) => s.paid_until);
  const intro = first && left > 0 ? INTRO[to.plan][to.term] : undefined;
  return {
    ...to,
    upfront: (intro ?? PRICE[to.plan][to.term]) * to.seats,
    startAt: addMonths(now, MONTHS[to.term]),
    upgrade: false,
    intro: !!intro,
  };
}

// A Razorpay plan per plan, term and price, made the first time it's needed. Plans belong to one Razorpay account
// and mode, so the key id is part of the name: new keys (test to live) make their own plans instead of reusing ids
// the new account has never seen ("The ID provided is invalid").
async function razorpayPlan(p: Paid, term: Term) {
  const key = `${process.env.RAZORPAY_KEY_ID}:${p}-${term}-${PRICE[p][term]}`;
  const got = await db.query<{ razorpay_id: string }>(`select razorpay_id from billing_plan where key = $1`, [key]);
  if (got.rows[0]) return got.rows[0].razorpay_id;
  const made = await rzp<{ id: string }>("POST", "/plans", {
    period: term === "year" ? "yearly" : "monthly",
    interval: term === "half" ? 6 : 1,
    item: { name: `todone ${NAME[p]} (${TERM_NAME[term]})`, amount: PRICE[p][term], currency: "INR", description: p === "team" ? "A seat" : "" },
    notes: { key },
  });
  await db.query(`insert into billing_plan (key, razorpay_id) values ($1, $2) on conflict do nothing`, [key, made.id]);
  return made.id;
}

// Starts checkout for Plus or Team: returns what Razorpay Checkout needs.
export async function checkout(b: Record<string, unknown>) {
  if (!billingOn) throw bad("Payments aren't set up on this server.");
  const { user } = await who();
  const to = choice(b);
  const p = await person(user);
  await enoughSeats(user, to);
  await dropUnpaid(user);
  const subs = await subsOf(user);
  const q = plan(to, subs, p, Date.now(), await launchLeft());
  const s = await rzp<{ id: string }>("POST", "/subscriptions", {
    plan_id: await razorpayPlan(to.plan, to.term),
    quantity: to.seats,
    total_count: { month: 120, half: 20, year: 10 }[to.term],
    start_at: unix(q.startAt),
    customer_notify: 1,
    ...(q.upfront
      ? { addons: [{ item: { name: q.upgrade ? "Upgrade, for the time already paid" : `First ${TERM_NAME[to.term]} term`, amount: q.upfront, currency: "INR" } }] }
      : {}),
    notes: { user, plan: to.plan, term: to.term, seats: String(to.seats) },
  });
  await db.query(
    `insert into billing_sub (id, user_id, plan, term, seats, upfront, start_at, intro) values ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8)`,
    [s.id, user, to.plan, to.term, to.seats, q.upfront, q.startAt / 1000, q.intro],
  );
  return { key: keyId, subscription: s.id, amount: q.upfront, startAt: q.startAt, name: p.name, email: p.email, what: label(to) };
}

// Founding member: one order, three years of Plus.
export async function founding() {
  if (!billingOn) throw bad("Payments aren't set up on this server.");
  const { user } = await who();
  const p = await person(user);
  await dropUnpaid(user);
  const o = await rzp<{ id: string }>("POST", "/orders", {
    amount: FOUNDING.amount,
    currency: "INR",
    receipt: `founding-${user}`.slice(0, 40),
    notes: { user, plan: "founding" },
  });
  await db.query(`insert into billing_sub (id, user_id, plan, term, seats, upfront) values ($1, $2, 'plus', 'founding', 1, $3)`, [
    o.id,
    user,
    FOUNDING.amount,
  ]);
  return { key: keyId, order: o.id, amount: FOUNDING.amount, name: p.name, email: p.email, what: "Founding member" };
}

const label = (s: { plan: Paid; term: Term | "founding"; seats: number }) =>
  s.term === "founding"
    ? "Founding member (3 years of Plus)"
    : `todone ${NAME[s.plan]}, ${TERM_NAME[s.term]}${s.plan === "team" ? `, ${s.seats} seat${s.seats === 1 ? "" : "s"}` : ""}`;

// Checkouts that were opened and never paid for.
async function dropUnpaid(user: string) {
  const { rows } = await db.query<{ id: string; term: string }>(
    `delete from billing_sub where user_id = $1 and status = 'created' and paid_until is null returning id, term`,
    [user],
  );
  for (const r of rows) if (r.term !== "founding") await rzp("POST", `/subscriptions/${r.id}/cancel`, {}).catch(() => {});
}

// Checkout said it worked: check its signature, then settle (the webhook does the same if this never arrives).
export async function confirm(b: Record<string, unknown>) {
  const { user } = await who();
  const payment = String(b.payment ?? "");
  const id = String(b.subscription ?? b.order ?? "");
  const signed = b.subscription ? `${payment}|${id}` : `${id}|${payment}`;
  if (!payment || !checkoutOk(signed, b.signature)) throw bad("That payment couldn't be checked.");
  const { rowCount } = await db.query(`select 1 from billing_sub where id = $1 and user_id = $2`, [id, user]);
  if (!rowCount) throw new ApiError(404, "No such purchase");
  await settle(id, payment);
  return status();
}

type Pay = { id: string; amount: number; status: string; email?: string };
// A purchase was paid for: it counts from now, the old one stops renewing, and the payment gets a receipt.
async function settle(id: string, paymentId: string | null) {
  const { rows } = await db.query<Sub & { user_id: string; upfront: number }>(`select * from billing_sub where id = $1`, [id]);
  const s = rows[0];
  if (!s) return;
  if (s.upfront && paymentId) {
    let pay = await rzp<Pay>("GET", `/payments/${paymentId}`);
    if (pay.status === "authorized")
      pay = await rzp<Pay>("POST", `/payments/${paymentId}/capture`, { amount: pay.amount, currency: "INR" });
    if (pay.status !== "captured") throw bad("That payment hasn't gone through yet.");
    await record(pay, s.user_id, id, label(s));
  }
  const until = s.term === "founding" ? addMonths(Date.now(), FOUNDING.months) : s.upfront ? +s.start_at! : null;
  await db.query(
    `update billing_sub set status = case when status = 'created' then 'authenticated' else status end,
       paid_until = greatest(paid_until, to_timestamp($2::float8 / 1000)) where id = $1`,
    [id, until],
  );
  await stopOthers(s.user_id, id);
}

// Everything else that would renew stops: started ones at their cycle end, ones not started yet now.
async function stopOthers(user: string, keep: string) {
  const { rows } = await db.query<Sub>(
    `select * from billing_sub where user_id = $1 and id <> $2 and term <> 'founding' and not cancel_at_end
       and status in ('active', 'authenticated', 'pending')`,
    [user, keep],
  );
  for (const o of rows) {
    const started = o.status !== "authenticated";
    await rzp("POST", `/subscriptions/${o.id}/cancel`, { cancel_at_cycle_end: started ? 1 : 0 }).catch((e) => console.error(e));
    await db.query(`update billing_sub set cancel_at_end = true, status = case when $2 then status else 'cancelled' end where id = $1`, [
      o.id,
      started,
    ]);
  }
}

async function record(pay: Pay, user: string | null, sub: string | null, what: string) {
  await db
    .query(
      `insert into billing_payment (id, user_id, email, sub_id, amount, what, invoice_no)
       select $1, $2, coalesce($3::text, (select email from "user" where id = $2), ''), $4, $5, $6,
              'TD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('billing_invoice_seq')::text, 5, '0')
       where not exists (select 1 from billing_payment where id = $1)`,
      [pay.id, user, pay.email ?? null, sub, pay.amount, what],
    )
    .catch((e) => {
      if (e.code !== "23505") throw e; // the same payment recorded twice at once
    });
}

// Stop renewing. What's paid for stays until its end.
export async function cancel() {
  const { user } = await who();
  await stopOthers(user, "");
  return status();
}

// Within 7 days of a charge: give it back and stop that subscription now.
export async function refund() {
  const { user } = await who();
  const { rows } = await db.query<{ id: string; amount: number; sub_id: string | null; created_at: Date }>(
    `select id, amount, sub_id, created_at from billing_payment where user_id = $1 and refunded = 0
       and created_at > now() - make_interval(days => $2) order by created_at desc limit 1`,
    [user, REFUND_DAYS],
  );
  const p = rows[0];
  if (!p) throw bad(`Only payments from the last ${REFUND_DAYS} days can be refunded here. Email us for anything else.`);
  await rzp("POST", `/payments/${p.id}/refund`, { notes: { reason: "Asked in the app" } });
  await db.query(`update billing_payment set refunded = amount where id = $1`, [p.id]);
  if (p.sub_id) {
    const s = await db.query<{ term: string }>(`select term from billing_sub where id = $1`, [p.sub_id]);
    if (s.rows[0]?.term !== "founding") await rzp("POST", `/subscriptions/${p.sub_id}/cancel`, { cancel_at_cycle_end: 0 }).catch(() => {});
    await db.query(`update billing_sub set status = 'refunded', paid_until = now(), cancel_at_end = true where id = $1`, [p.sub_id]);
  }
  return status();
}

// A receipt for one payment, with the seller's details from the environment.
export async function receipt(id: string) {
  const { user } = await who();
  const { rows } = await db.query(
    `select id, email, amount, refunded, what, invoice_no, created_at from billing_payment where id = $1 and user_id = $2`,
    [id, user],
  );
  if (!rows[0]) throw new ApiError(404, "No such receipt");
  const p = await person(user);
  return {
    ...rows[0],
    name: p.name,
    seller: {
      name: process.env.BILLING_NAME ?? "todone",
      address: process.env.BILLING_ADDRESS ?? "",
      gstin: process.env.BILLING_GSTIN ?? "",
    },
  };
}

// Razorpay's webhooks, checked against the webhook secret. Each delivery is handled once; handling is safe to repeat.
type Hook = {
  event: string;
  payload: {
    subscription?: { entity: { id: string; status: string; current_end?: number | null } };
    payment?: { entity: Pay & { order_id?: string; amount_refunded?: number } };
    order?: { entity: { id: string } };
    refund?: { entity: { payment_id: string; amount: number } };
  };
};
export async function webhook(raw: string, signature: string | undefined, eventId: string | undefined) {
  if (!webhookOk(raw, signature)) throw bad("Bad signature");
  const id = eventId || null;
  if (id && (await db.query(`select 1 from billing_event where id = $1`, [id])).rowCount) return { ok: true };
  const e = JSON.parse(raw) as Hook;
  const sub = e.payload.subscription?.entity;
  const pay = e.payload.payment?.entity;
  if (sub && e.event.startsWith("subscription.")) {
    const { rows } = await db.query<{ user_id: string; plan: Paid; term: Term; seats: number; upfront: number; paid_until: Date | null }>(
      `update billing_sub set status = $2 where id = $1 returning user_id, plan, term, seats, upfront, paid_until`,
      [sub.id, sub.status],
    );
    const s = rows[0];
    if (s && e.event === "subscription.charged" && pay) {
      await record(pay, s.user_id, sub.id, label(s));
      if (sub.current_end)
        await db.query(`update billing_sub set paid_until = greatest(paid_until, to_timestamp($2)) where id = $1`, [sub.id, sub.current_end]);
    }
    // Paid upfront but the app never confirmed (the tab closed): find the payment on its invoice.
    if (s && e.event === "subscription.authenticated" && s.upfront && !s.paid_until) {
      const inv = await rzp<{ items: { payment_id: string | null; status: string }[] }>("GET", `/invoices?subscription_id=${sub.id}`).catch(
        () => ({ items: [] }), // the app's own confirm usually got there first
      );
      const paid = inv.items.find((i) => i.status === "paid" && i.payment_id);
      if (paid) await settle(sub.id, paid.payment_id);
    }
  }
  if (e.event === "order.paid" && e.payload.order && pay) await settle(e.payload.order.entity.id, pay.id);
  if (e.event.startsWith("refund.") && e.payload.refund && pay?.amount_refunded !== undefined)
    await db.query(`update billing_payment set refunded = $2 where id = $1`, [e.payload.refund.entity.payment_id, pay.amount_refunded]);
  if (id) await db.query(`insert into billing_event (id) values ($1) on conflict do nothing`, [id]);
  return { ok: true };
}

// Deleting an account stops anything that would charge it again.
export async function stopAll(user: string) {
  if (billingOn) await stopOthers(user, "");
}
