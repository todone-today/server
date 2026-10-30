import type { Adapter } from "./sync-run";
import type { Remote, Service } from "./sync";
import type { Task } from "./tasks";

// Notion's REST API, two-way with one database the user shares with their integration.
const call = async (token: string, path: string, method = "GET", body?: unknown) => {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.message ?? `Notion said ${r.status}`), { status: r.status });
  return json;
};

export const NOTION: Service = { fields: ["title", "done", "due", "at"], include: () => true, onDelete: "delete" };

// Accepts a database id or the URL of the database page.
export const notionId = (s: string) => /([0-9a-f]{32})(?:\?|$)/i.exec(s.replace(/-/g, ""))?.[1] ?? null;

// Checks the token can see the database and gives it Done, Due and List columns; returns the title column's name.
export async function prepareDatabase(token: string, database: string): Promise<string> {
  const d = await call(token, `databases/${database}`);
  const props = d.properties as Record<string, { type: string }>;
  const title = Object.entries(props).find(([, p]) => p.type === "title")![0];
  const want = { Done: { checkbox: {} }, Due: { date: {} }, List: { rich_text: {} } };
  const missing = Object.fromEntries(Object.entries(want).filter(([k]) => !props[k]));
  if (Object.keys(missing).length) await call(token, `databases/${database}`, "PATCH", { properties: missing });
  return title;
}

type Page = { id: string; properties: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

const text = (rich: { plain_text: string }[] | undefined) =>
  (rich ?? [])
    .map((x) => x.plain_text)
    .join("")
    .trim();

export function notionAdapter(token: string, database: string, timeZone: string): Adapter {
  let title = "Name";
  const props = (t: Task, list: string) => ({
    [title]: { title: [{ text: { content: t.title } }] },
    Done: { checkbox: t.done },
    Due: { date: t.due ? { start: t.at ? `${t.due}T${t.at}:00` : t.due, ...(t.at ? { time_zone: timeZone } : {}) } : null },
    List: { rich_text: [{ text: { content: list } }] },
  });
  return {
    async pull(links) {
      title = await prepareDatabase(token, database);
      const pages: Page[] = [];
      let cursor: string | undefined;
      do {
        const r = await call(token, `databases/${database}/query`, "POST", { page_size: 100, start_cursor: cursor });
        pages.push(...r.results);
        cursor = r.has_more ? r.next_cursor : undefined;
      } while (cursor);
      // ponytail: a whole-database read each sync; fine for hundreds of pages, filter by last_edited_time beyond that.
      const remote: Remote[] = pages.flatMap((p) => {
        const name = text(p.properties[title]?.title);
        const start: string | undefined = p.properties.Due?.date?.start;
        return name
          ? [
              {
                id: p.id,
                title: name.slice(0, 500),
                done: !!p.properties.Done?.checkbox,
                due: start?.slice(0, 10),
                at: start && start.length > 10 ? start.slice(11, 16) : undefined,
                list: text(p.properties.List?.rich_text) || undefined,
              },
            ]
          : [];
      });
      const seen = new Set(pages.map((p) => p.id));
      return [
        ...remote,
        ...links.filter((l) => !seen.has(l.remoteId)).map((l) => ({ id: l.remoteId, title: "", deleted: true })),
      ];
    },
    create: async (t, list) =>
      (await call(token, "pages", "POST", { parent: { database_id: database }, properties: props(t, list) })).id,
    update: async (id, t, list) => void (await call(token, `pages/${id}`, "PATCH", { properties: props(t, list) })),
    remove: async (id) =>
      void (await call(token, `pages/${id}`, "PATCH", { archived: true }).catch((e) => {
        if (e.status !== 404) throw e;
      })),
  };
}
