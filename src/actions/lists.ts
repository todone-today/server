"use server";

import { after } from "next/server";
import { MINE, who } from "@/lib/access";
import { db } from "@/lib/db";
import { demoLists } from "@/lib/demo";
import { notifyDiscord } from "@/lib/notify";
import { autoSync } from "@/lib/sync-all";
import { type List, type Task, validName, validTasks } from "@/lib/tasks";

type Row = {
  id: string;
  name: string;
  tasks: List["tasks"];
  version: number;
  updatedAt: Date;
  kind: string;
  position: number | null;
};
const toList = (r: Row): List => ({
  id: r.id,
  name: r.name,
  tasks: r.tasks,
  version: r.version,
  updated: +r.updatedAt,
  ...(r.kind === "ideas" ? { kind: "ideas" } : {}),
  ...(r.position !== null ? { position: r.position } : {}),
});
const COLS = `id, name, tasks, version, "updatedAt", kind, position`;
// The lists of the active workspace: the user's own, or the active organization's.
export async function fetchLists(): Promise<List[]> {
  const { user, org, workspace } = await who();
  after(() => autoSync(workspace).catch(() => {}));
  const { rows } = org
    ? await db.query<Row>(`select ${COLS} from list where "organizationId" = $2 and ${MINE}`, [user, org])
    : await db.query<Row>(`select ${COLS} from list where "userId" = $1`, [user]);
  return rows.map(toList);
}

export async function createList(id: string, name: string, tasks: unknown, kind: unknown = "list"): Promise<List> {
  const { user, org } = await who();
  if (!/^[\w-]{8,40}$/.test(id) || !validName(name) || !validTasks(tasks) || (kind !== "list" && kind !== "ideas"))
    throw new Error("Invalid list");
  const { rows } = await db.query<Row>(
    `insert into list (id, "userId", "organizationId", name, tasks, kind) values ($1, $2, $3, $4, $5, $6) returning ${COLS}`,
    [id, org ? null : user, org, name.trim(), JSON.stringify(tasks), kind],
  );
  return toList(rows[0]);
}

// Saves only if nobody else saved since `version`; either way returns what is stored now (null if gone).
export async function saveList(
  id: string,
  version: number,
  name: string,
  tasks: unknown,
): Promise<{ ok: boolean; list: List | null }> {
  const { user } = await who();
  if (!validName(name) || !validTasks(tasks)) throw new Error("Invalid list");
  // The CTE reads the row as it was before the update, for the team notification.
  const { rows } = await db.query<Row & { before: Task[]; workspace: string }>(
    `with old as (select tasks from list where id = $2)
     update list set name = $4, tasks = $5, version = version + 1, "updatedAt" = now()
     where id = $2 and version = $3 and ${MINE}
     returning ${COLS}, (select tasks from old) as before,
       coalesce('o:' || "organizationId", 'u:' || "userId") as workspace`,
    [user, id, version, name.trim(), JSON.stringify(tasks)],
  );
  const r = rows[0];
  if (r) {
    after(() => notifyDiscord(r.workspace, user, r.name, r.before, r.tasks));
    return { ok: true, list: toList(r) };
  }
  const now = await db.query<Row>(`select ${COLS} from list where id = $2 and ${MINE}`, [user, id]);
  return { ok: false, list: now.rows[0] ? toList(now.rows[0]) : null };
}

export async function deleteList(id: string): Promise<void> {
  const { user } = await who();
  await db.query(`delete from list where id = $2 and ${MINE}`, [user, id]);
}

// Sidebar order after a drag: each list gets its index. Only lists the user may touch are changed.
export async function reorderLists(ids: unknown): Promise<void> {
  const { user } = await who();
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === "string")) throw new Error("Invalid order");
  await db.query(
    `update list set position = x.i from unnest($2::text[]) with ordinality as x(id, i)
     where list.id = x.id and ${MINE}`,
    [user, ids],
  );
}

// A person's first visit: once per account, fill an empty personal workspace with the demo lists and say
// to show the tour. `today` is the browser's date, so the demo's dates are the person's own.
export async function startOnboarding(today: unknown): Promise<boolean> {
  const { user } = await who();
  const day = typeof today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  const first = await db.query(
    `insert into workspace (id, onboarded) values ($1, true)
     on conflict (id) do update set onboarded = true where workspace.onboarded = false returning id`,
    [`u:${user}`],
  );
  if (!first.rowCount) return false;
  const has = await db.query(`select 1 from list where "userId" = $1 limit 1`, [user]);
  if (!has.rowCount)
    for (const [i, l] of demoLists(day).entries())
      await db.query(
        `insert into list (id, "userId", name, tasks, kind, position) values ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), user, l.name, JSON.stringify(l.tasks), l.kind ?? "list", i + 1], // Welcome first
      );
  return true;
}
