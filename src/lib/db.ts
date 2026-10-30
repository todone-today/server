import { Pool } from "pg";

// One pool per server instance; Neon (or any Postgres) via DATABASE_URL.
const g = globalThis as { pool?: Pool };
export const db = (g.pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));

// Tables the app owns; Better Auth migrates its own (user, session, organization, member, ...).
export const SCHEMA = `
create table if not exists list (
  id text primary key,
  "userId" text references "user"(id) on delete cascade,
  "organizationId" text references organization(id) on delete cascade,
  name text not null,
  tasks jsonb not null default '[]',
  version integer not null default 1,
  "updatedAt" timestamptz not null default now(),
  check (("userId" is null) <> ("organizationId" is null))
);
alter table list add column if not exists kind text not null default 'list' check (kind in ('list', 'ideas'));
create index if not exists list_user on list ("userId");
create index if not exists list_org on list ("organizationId");
-- Integration settings per workspace: 'u:<user id>' or 'o:<organization id>'.
-- ponytail: tokens are stored in plain text; encrypt at rest before handling many teams' Notion tokens.
create table if not exists workspace (
  id text primary key,
  "icsToken" text unique,
  "discordWebhook" text,
  "notionToken" text,
  "notionDatabase" text
);
alter table workspace add column if not exists "timeZone" text;
alter table workspace add column if not exists "googleUserId" text;
alter table workspace add column if not exists "googleCalendarId" text;
alter table workspace add column if not exists "googleSyncToken" text;
alter table workspace add column if not exists "syncToken" text unique;
alter table workspace add column if not exists "syncedAt" timestamptz;
alter table workspace add column if not exists "syncError" text;
-- Which remote item (Notion page, Google event) mirrors which task, and the task's fields as of the last sync.
create table if not exists sync_map (
  workspace text not null,
  service text not null,
  "taskId" text not null,
  "remoteId" text not null,
  hash text not null,
  primary key (workspace, service, "taskId")
);
drop table if exists notion_page;
`;
