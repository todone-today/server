import { ApiError, later, requestHeaders } from "../context.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";
import type { List } from "@todone/sdk/tasks";

// A list the user may touch ($1 = user id): their own, or one in an organization they belong to.
export const MINE = `("userId" = $1 or "organizationId" in (select "organizationId" from member where "userId" = $1))`;

// Marks the user active today (for the daily-active count), once per day per server process.
const marked = new Set<string>();
function seen(user: string) {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  if (marked.has(day + user)) return;
  if (marked.size > 100_000) marked.clear();
  marked.add(day + user);
  later(() => db.query(`insert into active_day (day, user_id) values ($1, $2) on conflict do nothing`, [day, user]));
}

// The signed-in user and the workspace they're in: "u:<user>" for personal lists, "o:<org>" for a team.
export async function who() {
  const s = await auth.api.getSession({ headers: requestHeaders() });
  if (!s) throw new ApiError(401, "Signed out");
  const user = s.user.id;
  seen(user);
  const org = s.session.activeOrganizationId ?? null;
  let role = "owner";
  if (org) {
    const m = await db.query<{ role: string }>(`select role from member where "userId" = $1 and "organizationId" = $2`, [
      user,
      org,
    ]);
    if (!m.rows[0]) throw new ApiError(403, "Not a member");
    role = m.rows[0].role;
  }
  return { user, org, workspace: org ? `o:${org}` : `u:${user}`, manager: role === "owner" || role === "admin" };
}

// Every readable list in a workspace, for the calendar feed, shared links and syncing (callers check access
// first). End-to-end encrypted lists are left out: only lists their owner switched off encryption are readable.
export async function workspaceLists(workspace: string) {
  const [kind, id] = [workspace.slice(0, 1), workspace.slice(2)];
  const { rows } = await db.query<{ id: string; name: string; tasks: List["tasks"]; version: number; updatedAt: Date }>(
    `select id, name, tasks, version, "updatedAt" from list where ${kind === "o" ? `"organizationId"` : `"userId"`} = $1 and kind = 'list' and data is null`,
    [id],
  );
  return rows.map((r): List => ({ id: r.id, name: r.name, tasks: r.tasks, version: r.version, updated: +r.updatedAt }));
}
