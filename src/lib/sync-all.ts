import { db } from "./db";
import { GOOGLE, googleAdapter } from "./google";
import { NOTION, notionAdapter } from "./notion";
import { runSync } from "./sync-run";

type Row = {
  notionToken: string | null;
  notionDatabase: string | null;
  googleUserId: string | null;
  googleCalendarId: string | null;
  googleSyncToken: string | null;
  timeZone: string | null;
  syncedAt: Date | null;
};

// Syncs every two-way service the workspace has connected; records the outcome for the Integrations page.
export async function syncWorkspace(workspace: string): Promise<string> {
  const { rows } = await db.query<Row>(`select * from workspace where id = $1`, [workspace]);
  const w = rows[0];
  if (!w) return "";
  const tz = w.timeZone ?? "UTC";
  const notes: string[] = [];
  const errors: string[] = [];
  const run = async (name: string, f: () => Promise<{ pulled: number; pushed: number; busy?: boolean }>) => {
    try {
      const r = await f();
      if (!r.busy) notes.push(`${name}: ${r.pulled} in, ${r.pushed} out`);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  if (w.notionToken && w.notionDatabase)
    await run("Notion", () => runSync(workspace, "notion", NOTION, notionAdapter(w.notionToken!, w.notionDatabase!, tz)));
  if (w.googleUserId && w.googleCalendarId)
    await run("Google Calendar", () =>
      runSync(
        workspace,
        "google",
        GOOGLE,
        googleAdapter(workspace, w.googleUserId!, w.googleCalendarId!, tz, w.googleSyncToken),
      ),
    );
  await db.query(`update workspace set "syncedAt" = now(), "syncError" = $2 where id = $1`, [
    workspace,
    errors.join("\n") || null,
  ]);
  return [...notes, ...errors].join(". ");
}

// Called when someone opens their lists: syncs in the background at most every two minutes per workspace.
export async function autoSync(workspace: string) {
  const r = await db.query(
    `update workspace set "syncedAt" = now()
     where id = $1 and ("notionToken" is not null or "googleCalendarId" is not null)
       and ("syncedAt" is null or "syncedAt" < now() - interval '2 minutes')`,
    [workspace],
  );
  if (r.rowCount) await syncWorkspace(workspace);
}
