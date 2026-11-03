import { test } from "node:test";
import assert from "node:assert/strict";
import { validTasks } from "@todone/sdk/tasks";
import { demoLists } from "./demo.ts";

test("demo lists are valid and dated from today", () => {
  const lists = demoLists("2026-10-31");
  assert.ok(lists.every((l) => validTasks(l.tasks)));
  const plan = lists[0].tasks.find((t) => t.title === "Plan the week")!;
  assert.deepEqual([plan.due, plan.at, plan.pri, plan.sub.length], ["2026-10-31", "16:00", 1, 2]);
  assert.equal(lists[0].tasks.find((t) => t.rep)?.due, "2026-11-01");
});
