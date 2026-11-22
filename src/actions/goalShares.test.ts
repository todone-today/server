import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "./goalShares.ts";

test("snapshot: only the goal's published fields, checked and cut to size", () => {
  const s = snapshot({
    title: "  Run a 5K  ",
    kind: "target",
    unit: "km",
    start: 1,
    target: 5,
    current: 3,
    towards: 0.5,
    thisWeek: 2,
    weeks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    reward: "New shoes",
    secret: "nope",
    email: "a@b.c",
  });
  assert.deepEqual(s, {
    title: "Run a 5K",
    kind: "target",
    towards: 0.5,
    thisWeek: 2,
    weeks: [2, 3, 4, 5, 6, 7, 8, 9],
    unit: "km",
    start: 1,
    target: 5,
    current: 3,
    reward: "New shoes",
  });
  assert.equal(snapshot({ title: "x", kind: "habit", towards: 7, thisWeek: -3, perWeek: 9 }).towards, 0);
  assert.equal(snapshot({ title: "x", kind: "habit", perWeek: 9 }).perWeek, undefined);
  assert.throws(() => snapshot({ title: "", kind: "habit" }));
  assert.throws(() => snapshot({ title: "x", kind: "nope" }));
});
