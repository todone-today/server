"use server";

import { randomBytes } from "node:crypto";
import { who } from "@/lib/access";
import { hasGoogle } from "@/lib/auth";
import { db } from "@/lib/db";
import { createCalendar } from "@/lib/google";
import { validDiscordWebhook } from "@/lib/integrations";
import { notionId, prepareDatabase } from "@/lib/notion";
import { syncWorkspace } from "@/lib/sync-all";

type Settings = {
  icsToken: string | null;
  discordWebhook: string | null;
  notionToken: string | null;
  notionDatabase: string | null;
  googleUserId: string | null;
  googleCalendarId: string | null;
  syncToken: string | null;
  syncedAt: Date | null;
  syncError: string | null;
};

async function settings(workspace: string): Promise<Partial<Settings>> {
  const { rows } = await db.query<Settings>(`select * from workspace where id = $1`, [workspace]);
  return rows[0] ?? {};
}

async function save(workspace: string, s: Record<string, string | null>) {
  const cols = Object.keys(s).map((k) => `"${k}"`);
  await db.query(
    `insert into workspace (id, ${cols}) values ($1, ${cols.map((_, i) => `$${i + 2}`)})
     on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`)}`,
    [workspace, ...Object.values(s)],
  );
}

// Team admins (or anyone, for personal lists) manage integrations; secrets never leave the server.
async function manager() {
  const w = await who();
  if (!w.manager) throw new Error("Only team owners and admins can change integrations.");
  return w;
}

const tz = (z: string) => (Intl.supportedValuesOf("timeZone").includes(z) ? z : "UTC");

export async function getIntegrations() {
  const w = await who();
  const s = await settings(w.workspace);
  const linked = await db.query(`select 1 from account where "userId" = $1 and "providerId" = 'google'`, [w.user]);
  return {
    manager: w.manager,
    icsToken: w.manager ? (s.icsToken ?? null) : null,
    syncToken: w.manager ? (s.syncToken ?? null) : null,
    discord: !!s.discordWebhook,
    notion: !!s.notionToken,
    google: {
      available: hasGoogle,
      linked: !!linked.rowCount,
      connected: !!s.googleCalendarId,
      mine: s.googleUserId === w.user,
    },
    syncedAt: s.syncedAt ? +s.syncedAt : null,
    syncError: s.syncError ?? null,
  };
}

export async function setCalendar(on: boolean): Promise<string | null> {
  const { workspace } = await manager();
  const icsToken = on ? randomBytes(24).toString("base64url") : null;
  await save(workspace, { icsToken });
  return icsToken;
}

export async function setMarkdownSync(on: boolean): Promise<void> {
  const { workspace } = await manager();
  await save(workspace, { syncToken: on ? randomBytes(24).toString("base64url") : null });
}

export async function setDiscord(url: string | null): Promise<string> {
  const { workspace } = await manager();
  const u = url?.trim() || null;
  if (u && !validDiscordWebhook(u)) return "That isn't a Discord webhook URL (https://discord.com/api/webhooks/…).";
  await save(workspace, { discordWebhook: u });
  if (u)
    await fetch(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "todone is connected. Added and finished tasks will show up here." }),
    }).catch(() => {});
  return "";
}

export async function setNotion(token: string | null, database: string, timeZone: string): Promise<string> {
  const { workspace } = await manager();
  if (!token) {
    await save(workspace, { notionToken: null, notionDatabase: null });
    await db.query(`delete from sync_map where workspace = $1 and service = 'notion'`, [workspace]);
    return "";
  }
  const id = notionId(database);
  if (!id) return "Paste the database's link or its 32-character id.";
  try {
    await prepareDatabase(token.trim(), id);
  } catch (e) {
    return `Notion: ${(e as Error).message}. Share the database with your integration (••• → Connections).`;
  }
  await save(workspace, { notionToken: token.trim(), notionDatabase: id, timeZone: tz(timeZone) });
  return syncWorkspace(workspace);
}

// After the Google account is linked (OAuth in the browser), make the "todone" calendar and sync into it.
export async function connectGoogle(timeZone: string): Promise<string> {
  const { workspace, user } = await manager();
  try {
    const calendar = await createCalendar(user, tz(timeZone));
    await save(workspace, { googleUserId: user, googleCalendarId: calendar, googleSyncToken: null, timeZone: tz(timeZone) });
    await db.query(`delete from sync_map where workspace = $1 and service = 'google'`, [workspace]);
    return syncWorkspace(workspace);
  } catch (e) {
    return `Google: ${(e as Error).message}`;
  }
}

export async function disconnectGoogle(): Promise<void> {
  const { workspace } = await manager();
  await save(workspace, { googleUserId: null, googleCalendarId: null, googleSyncToken: null });
  await db.query(`delete from sync_map where workspace = $1 and service = 'google'`, [workspace]);
}

export async function syncNow(): Promise<string> {
  const { workspace } = await who();
  return (await syncWorkspace(workspace)) || "Nothing to sync yet.";
}

// The token for sharing the calendar: the existing one, or a new one if the workspace has none yet.
// Sharing exposes dated tasks, so only those who manage integrations can turn it on.
export async function shareCalendar(): Promise<{ token: string } | { error: string }> {
  const w = await who();
  const s = await settings(w.workspace);
  if (s.icsToken) return { token: s.icsToken };
  if (!w.manager) return { error: "Ask a team owner or admin to turn on calendar sharing." };
  const icsToken = randomBytes(24).toString("base64url");
  await save(w.workspace, { icsToken });
  return { token: icsToken };
}
