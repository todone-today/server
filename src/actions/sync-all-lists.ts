import { workspaceLists } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { serialize } from "@todone/sdk/tasks";

// Two-way Markdown sync for Obsidian and other editors: every list in the workspace, as Markdown.
export async function syncedLists(token: string) {
  const { rows } = await db.query<{ id: string }>(`select id from workspace where "syncToken" = $1`, [token]);
  if (!rows[0]) return Response.json({ error: "Unknown sync link" }, { status: 404 });
  const lists = await workspaceLists(rows[0].id);
  return Response.json({
    lists: lists.map((l) => ({ name: l.name, version: l.version, markdown: serialize(l.tasks) })),
  });
}
