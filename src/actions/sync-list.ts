import { db } from "../lib/db.ts";
import { type Task, keepIds, parse, serialize, validName, validTasks } from "@todone/sdk/tasks";

type Row = { id: string; tasks: Task[]; version: number };

async function find(token: string, name: string) {
  const w = await db.query<{ id: string }>(`select id from workspace where "syncToken" = $1`, [token]);
  if (!w.rows[0]) return null;
  const ws = w.rows[0].id;
  const owner = ws.startsWith("o:") ? `"organizationId"` : `"userId"`;
  const l = await db.query<Row>(
    `select id, tasks, version from list where ${owner} = $1 and name = $2 and kind = 'list' and data is null`,
    [ws.slice(2), name],
  );
  return { ws, list: l.rows[0] ?? null };
}

// GET one list as Markdown (`list` arrives decoded); the ETag is its version.
export async function getList(token: string, list: string) {
  const f = await find(token, list.replace(/\.md$/, ""));
  if (!f?.list) return new Response("Not found\n", { status: 404 });
  return new Response(serialize(f.list.tasks), {
    headers: { "content-type": "text/markdown; charset=utf-8", etag: `"${f.list.version}"` },
  });
}

// PUT a list's Markdown: replaces its tasks (creating the list if new). Send If-Match with the ETag to refuse
// overwriting someone else's newer edit (412).
export async function putList(req: Request, token: string, list: string) {
  const name = list.replace(/\.md$/, "").trim();
  const f = await find(token, name);
  if (!f) return new Response("Not found\n", { status: 404 });
  const body = await req.text();
  if (body.length > 500_000 || !validName(name)) return new Response("Too large or bad name\n", { status: 413 });
  const tasks = keepIds(f.list?.tasks ?? [], parse(body));
  if (!validTasks(tasks)) return new Response("Tasks don't fit the format\n", { status: 422 });
  const match = req.headers.get("if-match")?.replace(/"/g, "");

  if (!f.list) {
    const [user, org] = f.ws.startsWith("o:") ? [null, f.ws.slice(2)] : [f.ws.slice(2), null];
    const r = await db.query<{ version: number }>(
      `insert into list (id, "userId", "organizationId", name, tasks) values ($1, $2, $3, $4, $5) returning version`,
      [crypto.randomUUID(), user, org, name, JSON.stringify(tasks)],
    );
    return new Response(null, { status: 201, headers: { etag: `"${r.rows[0].version}"` } });
  }
  const r = await db.query<{ version: number }>(
    `update list set tasks = $2, version = version + 1, "updatedAt" = now()
     where id = $1 and ($3::int is null or version = $3) returning version`,
    [f.list.id, JSON.stringify(tasks), match ? +match : null],
  );
  if (!r.rows[0])
    return new Response("Changed since you read it\n", { status: 412, headers: { etag: `"${f.list.version}"` } });
  return new Response(null, { status: 204, headers: { etag: `"${r.rows[0].version}"` } });
}
