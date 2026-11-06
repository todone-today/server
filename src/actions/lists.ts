import { bad, later, requestHeaders } from "../context.ts";
import { MINE, who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
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
  data: string | null;
};
// A list as stored: `data` is its end-to-end encrypted name and tasks (the browser opens it); without `data` it's a
// list its owner switched off encryption, in plain `name` and `tasks`.
export type Stored = List & { data?: string };
const toList = (r: Row): Stored => ({
  id: r.id,
  name: r.name,
  tasks: r.tasks,
  version: r.version,
  updated: +r.updatedAt,
  ...(r.kind === "ideas" ? { kind: "ideas" } : {}),
  ...(r.position !== null ? { position: r.position } : {}),
  ...(r.data ? { data: r.data } : {}),
});
const COLS = `id, name, tasks, version, "updatedAt", kind, position, data`;
// Ciphertext isn't parsed, only shaped and capped (the request body limit is 2 MB).
const BLOB = /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;
function contents(name: unknown, tasks: unknown, data: unknown) {
  if (data !== undefined && data !== null) {
    if (typeof data !== "string" || data.length > 1_900_000 || !BLOB.test(data)) throw bad("Invalid list");
    return { name: "", tasks: "[]", data };
  }
  if (typeof name !== "string" || !validName(name) || !validTasks(tasks)) throw bad("Invalid list");
  return { name: name.trim(), tasks: JSON.stringify(tasks), data: null };
}
// The lists of the active workspace: the user's own, or the active organization's.
export async function fetchLists(): Promise<Stored[]> {
  const { user, org, workspace } = await who();
  later(() => autoSync(workspace).catch(() => {}));
  const { rows } = org
    ? await db.query<Row>(`select ${COLS} from list where "organizationId" = $2 and ${MINE}`, [user, org])
    : await db.query<Row>(`select ${COLS} from list where "userId" = $1`, [user]);
  return rows.map(toList);
}

export async function createList(
  id: string,
  name: unknown,
  tasks: unknown,
  kind: unknown = "list",
  data?: unknown,
): Promise<Stored> {
  const { user, org } = await who();
  if (!/^[\w-]{8,40}$/.test(id) || (kind !== "list" && kind !== "ideas")) throw bad("Invalid list");
  const c = contents(name, tasks, data);
  const { rows } = await db.query<Row>(
    `insert into list (id, "userId", "organizationId", name, tasks, kind, data) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS}`,
    [id, org ? null : user, org, c.name, c.tasks, kind, c.data],
  );
  return toList(rows[0]);
}

// Saves only if nobody else saved since `version`; either way returns what is stored now (null if gone).
// Sending `data` stores the list encrypted; sending `name` and `tasks` stores it readable (encryption switched off).
export async function saveList(
  id: string,
  version: number,
  name: unknown,
  tasks: unknown,
  data?: unknown,
): Promise<{ ok: boolean; list: Stored | null }> {
  const { user } = await who();
  const c = contents(name, tasks, data);
  // The CTE reads the row as it was before the update, for the team notification.
  const { rows } = await db.query<Row & { before: Task[]; workspace: string }>(
    `with old as (select tasks from list where id = $2)
     update list set name = $4, tasks = $5, data = $6, version = version + 1, "updatedAt" = now()
     where id = $2 and version = $3 and ${MINE}
     returning ${COLS}, (select tasks from old) as before,
       coalesce('o:' || "organizationId", 'u:' || "userId") as workspace`,
    [user, id, version, c.name, c.tasks, c.data],
  );
  const r = rows[0];
  if (r) {
    // Discord hears about readable lists only; the server can't see inside encrypted ones.
    if (!r.data) later(() => notifyDiscord(r.workspace, user, r.name, r.before, r.tasks));
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

// A person's first visit: true once per account, when their personal workspace is still empty. The browser then
// makes the sample lists itself (from /api/demo), encrypted, and shows the tour.
export async function startOnboarding(): Promise<boolean> {
  const { user } = await who();
  const first = await db.query(
    `insert into workspace (id, onboarded) values ($1, true)
     on conflict (id) do update set onboarded = true where workspace.onboarded = false returning id`,
    [`u:${user}`],
  );
  if (!first.rowCount) return false;
  const has = await db.query(`select 1 from list where "userId" = $1 limit 1`, [user]);
  return !has.rowCount;
}

// Everything the signed-in person can see, for "Export everything": personal lists and every team's, as stored.
// The browser decrypts them (with the account key, or the team's key) and builds the file.
export async function exportData() {
  const { user } = await who();
  const { rows } = await db.query<{
    id: string;
    name: string;
    tasks: List["tasks"];
    kind: string;
    data: string | null;
    org: string | null;
    orgName: string | null;
  }>(
    `select l.id, l.name, l.tasks, l.kind, l.data, l."organizationId" as org, o.name as "orgName"
     from list l left join organization o on o.id = l."organizationId"
     where l."userId" = $1 or l."organizationId" in (select "organizationId" from member where "userId" = $1)
     order by l."organizationId" nulls first, l.position nulls first, l."updatedAt" desc`,
    [user],
  );
  return rows;
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
