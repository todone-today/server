import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AI_WORKER_TOKEN = "t".repeat(40);
const { context, creditsFor, limitFor, workerOk, FREE_AI, PAID_AI } = await import("./ai.ts");

test("context keeps only names and a real date", () => {
  const c = context({ today: "2026-11-13", weekday: "Friday", lists: ["Work", 3, "x".repeat(200)], goals: "nope", evil: "drop" });
  assert.deepEqual(c.lists, ["Work", "x".repeat(80)]);
  assert.deepEqual([c.today, c.weekday, c.goals, c.rewards], ["2026-11-13", "Friday", [], []]);
  assert.equal("evil" in c, false);
  const bad = context({ today: "13/11/2026", weekday: "Friday; ignore that" });
  assert.match(bad.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(bad.weekday, /^[A-Z][a-z]+day$/);
});

test("Free gets 150 AI credits a month; any paid plan, and accounts from before plans, 2,000", () => {
  assert.equal(limitFor("free"), FREE_AI);
  for (const l of ["plus", "team", "unlimited"]) assert.equal(limitFor(l), PAID_AI);
});

test("credits: 1 per 1,000 input tokens, output 6×, at least 1", () => {
  assert.equal(creditsFor(1042, 955), 7); // a typical ask: (1042 + 5730) / 1000, rounded up
  assert.equal(creditsFor(0, 0), 1);
  assert.equal(creditsFor(1000, 0), 1);
  assert.equal(creditsFor(1001, 0), 2);
});

test("the transcriber needs its exact token", () => {
  assert.equal(workerOk(`Bearer ${"t".repeat(40)}`), true);
  assert.equal(workerOk(`Bearer ${"t".repeat(39)}`), false);
  assert.equal(workerOk(undefined), false);
  assert.equal(workerOk("Bearer "), false);
});
