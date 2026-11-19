import { test } from "node:test";
import assert from "node:assert/strict";
import { monthly, statsAllowed } from "./stats.ts";

test("MRR counts a plan's price per month, the launch price while in its first term", () => {
  const base = { plan: "plus" as const, seats: 1, upfront: 0, intro: false, renewed: false };
  assert.equal(monthly({ ...base, term: "month" }), 9_900);
  assert.equal(monthly({ ...base, term: "year", upfront: 59_900, intro: true }), 59_900 / 12);
  assert.equal(monthly({ ...base, term: "year", upfront: 59_900, intro: true, renewed: true }), 89_900 / 12);
  assert.equal(monthly({ ...base, plan: "team", term: "half", seats: 3 }), (79_900 * 3) / 6);
  assert.equal(monthly({ ...base, term: "founding" }), 1_99_900 / 36);
});

test("stats are off without a token", () => {
  assert.equal(statsAllowed("Bearer "), false);
  assert.equal(statsAllowed(undefined), false);
});
