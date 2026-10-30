import { db } from "./db";
import { changes } from "./integrations";
import type { Task } from "./tasks";

// Posts "added" and "finished" lines to the workspace's Discord channel, if one is connected.
export async function notifyDiscord(workspace: string, userId: string, list: string, before: Task[], after: Task[]) {
  const { added, done } = changes(before, after);
  if (!added.length && !done.length) return;
  const { rows } = await db.query<{ discordWebhook: string | null; name: string }>(
    `select w."discordWebhook", u.name from workspace w, "user" u where w.id = $1 and u.id = $2`,
    [workspace, userId],
  );
  const hook = rows[0]?.discordWebhook;
  if (!hook) return;
  const lines = [
    ...done.map((t) => `✅ ${rows[0].name} finished **${t}**`),
    ...added.map((t) => `➕ ${rows[0].name} added **${t}**`),
  ];
  const content = `*${list}*\n${lines.join("\n")}`.slice(0, 2000);
  // allowed_mentions off: task titles must not ping @everyone.
  await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }).catch(() => {});
}
