import { bad, later, requestHeaders } from "../context.ts";
import { MINE, who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { demoLists } from "../lib/demo.ts";
import type { Export } from "@todone/sdk/export";
import { notifyDiscord } from "../lib/notify.ts";
import { autoSync } from "../lib/sync-all.ts";
import { type List, type Task, validName, validTasks } from "@todone/sdk/tasks";

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
  later(() => autoSync(workspace).catch(() => {}));
  const { rows } = org
    ? await db.query<Row>(`select ${COLS} from list where "organizationId" = $2 and ${MINE}`, [user, org])
    : await db.query<Row>(`select ${COLS} from list where "userId" = $1`, [user]);
  return rows.map(toList);
}

export async function createList(id: string, name: string, tasks: unknown, kind: unknown = "list"): Promise<List> {
  const { user, org } = await who();
  if (!/^[\w-]{8,40}$/.test(id) || !validName(name) || !validTasks(tasks) || (kind !== "list" && kind !== "ideas"))
    throw bad("Invalid list");
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
  if (!validName(name) || !validTasks(tasks)) throw bad("Invalid list");
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
    later(() => notifyDiscord(r.workspace, user, r.name, r.before, r.tasks));
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
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === "string")) throw bad("Invalid order");
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

// Everything the signed-in person can see, for "Export everything": personal lists and every team's.
export async function exportData(): Promise<Export> {
  const { user } = await who();
  const { rows } = await db.query<{
    name: string;
    tasks: List["tasks"];
    kind: string;
    org: string | null;
    orgName: string | null;
  }>(
    `select l.name, l.tasks, l.kind, l."organizationId" as org, o.name as "orgName"
     from list l left join organization o on o.id = l."organizationId"
     where l."userId" = $1 or l."organizationId" in (select "organizationId" from member where "userId" = $1)
     order by l."organizationId" nulls first, l.position nulls first, l."updatedAt" desc`,
    [user],
  );
  const spaces = new Map<string, Export["workspaces"][number]>();
  for (const r of rows) {
    const key = r.org ?? "personal";
    if (!spaces.has(key)) spaces.set(key, { name: r.orgName ?? "Personal", team: !!r.org, lists: [] });
    spaces.get(key)!.lists.push({ name: r.name, ideas: r.kind === "ideas", tasks: r.tasks });
  }
  return { exportedAt: new Date().toISOString(), workspaces: [...spaces.values()] };
}

const KINDS = ["bug", "idea", "other"];

export async function sendFeedback(kind: string, body: string, page: string) {
  const { user } = await who();
  const text = String(body).trim();
  if (!KINDS.includes(kind) || !text || text.length > 5000) throw bad("Bad feedback");
  const agent = requestHeaders().get("user-agent")?.slice(0, 300) ?? null;
  await db.query(`insert into feedback ("userId", kind, body, page, agent) values ($1, $2, $3, $4, $5)`, [
    user,
    kind,
    text,
    String(page).slice(0, 300),
    agent,
  ]);
}
