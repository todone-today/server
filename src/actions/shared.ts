import { type CalView, rangeOf } from "@todone/sdk/calendar";
import type { SharedView } from "@todone/sdk/api";
import { workspaceLists } from "../lib/access.ts";
import { db } from "../lib/db.ts";

// What a calendar link shows, for the web app's /calendar/<token> page: a shared view (one day, week, month or
// year, locked, with only that period's tasks) or, for the calendar feed's own token, the whole calendar.
export async function sharedView(token: string): Promise<SharedView | null> {
  const share = (
    await db.query<{ workspace: string; view: CalView; at: string }>(
      `select workspace, view, at from calendar_share where token = $1`,
      [token],
    )
  ).rows[0];
  if (share) {
    const [from, to] = rangeOf(share.view, share.at);
    const lists = (await workspaceLists(share.workspace)).map((l) => ({
      ...l,
      tasks: l.tasks
        .flatMap((t) => [t, ...t.sub])
        .filter((t) => t.due && t.due >= from && t.due <= to)
        .map((t) => ({ ...t, sub: [] })),
    }));
    return { lists, start: { view: share.view, at: share.at }, locked: true };
  }
  const { rows } = await db.query<{ id: string }>(`select id from workspace where "icsToken" = $1`, [token]);
  return rows[0] ? { lists: await workspaceLists(rows[0].id), locked: false } : null;
}
