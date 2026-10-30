import { auth } from "./auth";
import { db } from "./db";
import { type Event, eventTimes, fromEvent } from "./integrations";
import type { Remote, Service } from "./sync";
import type { Adapter } from "./sync-run";
import type { Task } from "./tasks";

// Dated open tasks live as events on a "todone" calendar; deleting an event unschedules its task.
export const GOOGLE: Service = {
  fields: ["title", "due", "at", "est"],
  include: (t) => !!t.due && !t.done,
  onDelete: "unschedule",
};

async function token(userId: string) {
  const { rows } = await db.query<{ id: string }>(`select id from account where "userId" = $1 and "providerId" = 'google'`, [
    userId,
  ]);
  if (!rows[0]) throw new Error("Google isn't connected for this account.");
  const t = await auth.api.getAccessToken({ body: { accountId: rows[0].id, userId } });
  return t.accessToken;
}

const call = async (bearer: string, path: string, method = "GET", body?: unknown) => {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error?.message ?? `Google said ${r.status}`), { status: r.status });
  return json;
};

export async function createCalendar(userId: string, timeZone: string): Promise<string> {
  return (await call(await token(userId), "calendars", "POST", { summary: "todone", timeZone })).id;
}

export function googleAdapter(
  workspace: string,
  userId: string,
  calendar: string,
  timeZone: string,
  syncToken: string | null,
): Adapter {
  let bearer = "";
  let next: string | null = null;
  const events = `calendars/${encodeURIComponent(calendar)}/events`;
  const body = (t: Task) => ({
    summary: t.title,
    ...eventTimes(t, timeZone),
    extendedProperties: { private: { todone: t.id } },
  });
  return {
    async pull() {
      bearer = await token(userId);
      // Incremental after the first sync; Google answers 410 when the token is too old, then read everything again.
      const read = async (since: string | null) => {
        const out: Remote[] = [];
        let page: string | undefined;
        do {
          const q = new URLSearchParams({ timeZone, showDeleted: "true", maxResults: "250" });
          if (since) q.set("syncToken", since);
          if (page) q.set("pageToken", page);
          const r = await call(bearer, `${events}?${q}`);
          out.push(...(r.items as Event[]).flatMap((e) => fromEvent(e) ?? []));
          page = r.nextPageToken;
          next = r.nextSyncToken ?? next;
        } while (page);
        return out;
      };
      try {
        return await read(syncToken);
      } catch (e) {
        if ((e as { status?: number }).status !== 410) throw e;
        return read(null);
      }
    },
    create: async (t) => (await call(bearer, events, "POST", body(t))).id,
    update: async (id, t) => void (await call(bearer, `${events}/${id}`, "PATCH", body(t))),
    remove: async (id) =>
      void (await call(bearer, `${events}/${id}`, "DELETE").catch((e) => {
        if (![404, 410].includes(e.status)) throw e;
      })),
    // Our own pushes come back in the next incremental read; the fingerprints match, so they change nothing.
    done: async () => void (await db.query(`update workspace set "googleSyncToken" = $2 where id = $1`, [workspace, next])),
  };
}
