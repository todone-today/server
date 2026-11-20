import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AI_WORKER_TOKEN = "t".repeat(40);
const { context, creditsFor, limitFor, workerOk, withMode, FREE_AI, PAID_AI } = await import("./ai.ts");
const { planPrompt } = await import("@todone/sdk/plan");

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

test("context: shared lists are kept, up to 3, each cut to size; junk dropped", () => {
  const c = context({ open: [{ name: "Trip", md: "- [ ] Pack [#1]" }, { name: 3 }, ...Array(5).fill({ name: "X", md: "y".repeat(30_000) })] });
  assert.equal(c.open?.length, 3);
  assert.deepEqual(c.open?.[0], { name: "Trip", md: "- [ ] Pack [#1]" });
  assert.equal(c.open?.[1].md.length, 20_000);
  assert.equal("open" in context({}), false);
});

test("context keeps the conversation (its latest part) and up to 3 waiting questions", () => {
  const c = context({ earlier: "x".repeat(5000) + "end", asked: ["How many days?", 4, "", "Which gym?", "c", "d"] });
  assert.equal(c.earlier?.length, 3000);
  assert.ok(c.earlier?.endsWith("end"));
  assert.deepEqual(c.asked, ["How many days?", "Which gym?", "c"]);
  assert.equal(context({}).earlier, undefined);
  assert.equal(context({}).asked, undefined);
});

test("a long brain dump is planned in parts of about 100 lines; a short one isn't split", async () => {
  const { parts } = await import("./ai.ts");
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `task ${i + 1}`).join("\n");
  assert.equal(parts(lines(120)).length, 1);
  const p = parts(lines(250));
  assert.deepEqual(p.map((x) => x.split("\n").length), [100, 100, 50]);
  assert.equal(p.join("\n"), lines(250)); // nothing lost, order kept
});

test("Brainstorm asks get ideas-only rules; shared lists get change rules; plain asks are unchanged", () => {
  const base = { today: "2026-11-19", weekday: "Thursday", lists: ["Work"] };
  const ideas = context({ ...base, mode: "ideas" });
  assert.equal(ideas.mode, "ideas");
  const p = withMode(planPrompt(ideas), ideas);
  assert.match(p, /only tasks, one per\s+idea[\s\S]*## Ideas[\s\S]*Here's what I need:\s*$/);
  const change = context({ ...base, open: [{ name: "Work", md: "- [ ] [#1] Email Priya" }] });
  assert.equal(change.mode, "change");
  assert.match(withMode(planPrompt(change), change), /no "## Questions"[\s\S]*Here's what I need:/);
  const plain = context(base);
  assert.equal(plain.mode, undefined);
  assert.equal(withMode(planPrompt(plain), plain), planPrompt(plain));
  assert.equal(context({ ...base, mode: "admin" }).mode, undefined);
  const start = context({ ...base, mode: "start" });
  assert.equal(start.mode, "start");
  assert.match(withMode(planPrompt(start), start), /first time in todone[\s\S]*## Ideas[\s\S]*No "## Questions"[\s\S]*Here's what I need:/);
});
