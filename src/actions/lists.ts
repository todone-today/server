"use server";

import { after } from "next/server";
import { MINE, who } from "@/lib/access";
import { db } from "@/lib/db";
import { notifyDiscord } from "@/lib/notify";
import { autoSync } from "@/lib/sync-all";
import { type List, type Task, validName, validTasks } from "@/lib/tasks";

type Row = { id: string; name: string; tasks: List["tasks"]; version: number; updatedAt: Date; kind: string };
const toList = (r: Row): List => ({
  id: r.id,
  name: r.name,
  tasks: r.tasks,
  version: r.version,
  updated: +r.updatedAt,
  ...(r.kind === "ideas" ? { kind: "ideas" } : {}),
});
const COLS = `id, name, tasks, version, "updatedAt", kind`;
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
