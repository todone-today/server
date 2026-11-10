import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Billing is on only with keys and a launch date; set them before the modules read them.
Object.assign(process.env, {
  RAZORPAY_KEY_ID: "rzp_test_x",
  RAZORPAY_KEY_SECRET: "secret",
  RAZORPAY_WEBHOOK_SECRET: "hook",
  BILLING_START: "2026-11-10T00:00:00Z",
});
const { entitle, upgradeCost, GRACE } = await import("./plans.ts");
const { signs, webhookOk, checkoutOk } = await import("./razorpay.ts");

const NOW = Date.parse("2026-12-01T00:00:00Z");
const NEW = new Date("2026-11-20T00:00:00Z");
const OLD = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
const sub = (o: object) => ({
  id: "s",
  plan: "plus" as const,
  term: "year" as const,
  seats: 1,
  status: "active",
  paid_until: new Date(NOW + 30 * DAY),
  start_at: null,
  cancel_at_end: false,
  ...o,
});

test("accounts from before launch are never limited", () => {
  assert.equal(entitle([], NOW, OLD).level, "unlimited");
  assert.equal(entitle([], NOW, NEW).level, "free");
});

test("a plan counts until it's paid to, plus grace while a renewal is retried, but not after a refund", () => {
  assert.equal(entitle([sub({})], NOW, NEW).level, "plus");
  assert.equal(entitle([sub({ status: "cancelled", cancel_at_end: true })], NOW, NEW).level, "plus");
  assert.equal(entitle([sub({ status: "pending", paid_until: new Date(NOW - DAY) })], NOW, NEW).level, "plus");
  assert.equal(entitle([sub({ status: "halted", paid_until: new Date(NOW - GRACE - 1) })], NOW, NEW).level, "free");
  assert.equal(entitle([sub({ status: "refunded", paid_until: new Date(NOW) })], NOW, NEW).level, "free");
  assert.equal(entitle([sub({ status: "created", paid_until: null })], NOW, NEW).level, "free");
});

test("the best plan wins: Team over Plus, more seats over fewer", () => {
  const e = entitle([sub({}), sub({ id: "t", plan: "team", seats: 3 }), sub({ id: "u", plan: "team", seats: 8 })], NOW, NEW);
  assert.deepEqual([e.level, e.seats, e.sub?.id], ["team", 8, "u"]);
});

test("upgrading costs the difference for the days left; moving down costs nothing now", () => {
  const plusYear = sub({ paid_until: new Date(NOW + 182.6 * DAY) }); // half a year left of ₹899
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) / b < 0.005, `${a} ≈ ${b}`);
  // Team yearly, 3 seats (₹4,497 a year) for half a year, less half a year of Plus.
  near(upgradeCost(plusYear, { plan: "team", term: "year", seats: 3 }, NOW), (449_700 - 89_900) / 2);
  // Another term on the same plan waits for the renewal.
  assert.equal(upgradeCost(plusYear, { plan: "plus", term: "month", seats: 1 }, NOW), 0);
  // More seats: the extra seats for the days left.
  near(upgradeCost(sub({ plan: "team", seats: 2, paid_until: new Date(NOW + 182.6 * DAY) }), { plan: "team", term: "year", seats: 5 }, NOW), (3 * 149_900) / 2);
  assert.equal(upgradeCost(sub({ plan: "team", seats: 5 }), { plan: "plus", term: "year", seats: 1 }, NOW), 0);
  assert.equal(upgradeCost(sub({ paid_until: new Date(NOW + 1000) }), { plan: "team", term: "year", seats: 1 }, NOW), 100); // ₹1 at least
});

test("checkout and webhook signatures", () => {
  const h = (k: string, s: string) => createHmac("sha256", k).update(s).digest("hex");
  assert.ok(checkoutOk("pay_1|sub_1", h("secret", "pay_1|sub_1")));
  assert.ok(!checkoutOk("pay_1|sub_2", h("secret", "pay_1|sub_1")));
  assert.ok(!checkoutOk("pay_1|sub_1", undefined));
  assert.ok(webhookOk('{"a":1}', h("hook", '{"a":1}')));
  assert.ok(!webhookOk('{"a":2}', h("hook", '{"a":1}')));
  assert.ok(!signs("k", "x", "short"));
});
