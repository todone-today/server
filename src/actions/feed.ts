import { workspaceLists } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { toICS } from "@todone/sdk/integrations";

// A secret-URL calendar feed: subscribe from Google Calendar, Apple Calendar or Outlook.
export async function feed(req: Request, file: string) {
  const token = file.replace(/\.ics$/, "");
  // A person opening the link in a browser sees the calendar; calendar apps (which don't ask for HTML) get the feed.
  if (req.headers.get("accept")?.startsWith("text/html"))
    // Relative, so the browser stays on the web app's address rather than this server's.
    return new Response(null, { status: 307, headers: { location: `/calendar/${token}` } });
  const { rows } = await db.query<{ id: string }>(`select id from workspace where "icsToken" = $1`, [token]);
  if (!rows[0]) return new Response("Not found", { status: 404 });
  return new Response(toICS("todone", await workspaceLists(rows[0].id)), {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300" },
  });
}
