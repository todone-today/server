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
-- Order in the sidebar once someone drags lists around; lists without one come first, newest first.
alter table list add column if not exists position integer;
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
-- Set once a person's first visit has made the demo lists and offered the tour.
alter table workspace add column if not exists onboarded boolean not null default false;
-- Push notifications: one row per device that turned them on, and what was already sent (so nothing repeats).
create table if not exists push_sub (
  endpoint text primary key,
  "userId" text not null references "user"(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  "timeZone" text not null default 'UTC',
  "createdAt" timestamptz not null default now()
);
create table if not exists push_sent (
  "userId" text not null references "user"(id) on delete cascade,
  key text not null,
  "sentAt" timestamptz not null default now(),
  primary key ("userId", key)
);
-- Requests per client per time window, for the API's rate limits (lib/rate-limit.ts).
create table if not exists rate_limit (
  key text not null,
  "window" bigint not null,
  count int not null default 1,
  primary key (key, "window")
);
-- Accounts from before email confirmation existed count as confirmed, so the 7-day clean-up never touches them.
update "user" set "emailVerified" = true where "emailVerified" = false and "createdAt" < '2026-11-06T12:00:00Z';
-- Gravatar pictures for accounts that have none (new accounts get one when they sign up).
update "user" set image = 'https://gravatar.com/avatar/' || encode(sha256(convert_to(lower(trim(email)), 'UTF8')), 'hex') || '?s=160&d=404'
  where image is null or image = '';
-- What people send from "Send feedback": bugs, ideas, anything else. Read it straight from the database.
create table if not exists feedback (
  id bigserial primary key,
  "userId" text not null references "user"(id) on delete cascade,
  kind text not null,
  body text not null,
  page text,
  agent text,
  "createdAt" timestamptz not null default now()
);
-- Shared calendar views: each link shows one view (day, week, month or year) around one date, nothing else.
create table if not exists calendar_share (
  token text primary key,
  workspace text not null,
  view text not null check (view in ('day', 'week', 'month', 'year')),
  at text not null,
  "createdAt" timestamptz not null default now()
);
create index if not exists calendar_share_workspace on calendar_share (workspace);
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
-- End-to-end encryption: a list's name and tasks as one ciphertext ("v1.<iv>.<ct>"), opened only in the browser.
-- null = a list its owner switched off encryption, readable here (integrations use only those).
alter table list add column if not exists data text;
-- A workspace's bin (recently deleted tasks, kept 7 days by the app) is a list of kind 'bin'.
alter table list drop constraint if exists list_kind_check;
alter table list add constraint list_kind_check check (kind in ('list', 'ideas', 'bin', 'goals'));
-- A plain list's icon (an encrypted list keeps its icon inside data).
alter table list add column if not exists icon text;
-- Each member's copy of their team's key, wrapped to their public key (user."publicKey").
create table if not exists org_key (
  "organizationId" text not null references organization(id) on delete cascade,
  "userId" text not null references "user"(id) on delete cascade,
  wrapped text not null,
  primary key ("organizationId", "userId")
);
-- Attachments in R2 (lib/r2.ts). enc: end-to-end encrypted by the browser (private tasks); readable otherwise
-- (shared tasks, share_id). Unconfirmed uploads are pruned after a day.
create table if not exists task_share (
  id text primary key,
  token text not null unique,
  workspace text not null,
  owner text not null references "user"(id) on delete cascade,
  task jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists task_share_workspace on task_share (workspace);
create table if not exists file (
  id text primary key,
  workspace text not null,
  share_id text references task_share(id) on delete cascade,
  key text not null,
  name text not null,
  type text not null,
  size bigint not null,
  enc boolean not null default false,
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists file_workspace on file (workspace);
create index if not exists file_share on file (share_id);
create table if not exists share_comment (
  id bigserial primary key,
  share_id text not null references task_share(id) on delete cascade,
  parent_id bigint references share_comment(id) on delete cascade,
  author_user text references "user"(id) on delete set null,
  guest_no integer,
  body text not null,
  files jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists share_comment_share on share_comment (share_id);
create table if not exists share_guest (
  share_id text not null references task_share(id) on delete cascade,
  guest_key text not null,
  no integer not null,
  primary key (share_id, guest_key)
);
-- The name a guest chose for themselves (blank = "Anonymous"); self-declared, not checked.
alter table share_guest add column if not exists name text;
-- Server push reminders read task titles and times; with end-to-end encryption the app reminds instead.
drop table if exists push_sent;
drop table if exists push_sub;
-- Reminders with the app closed, end to end: the app seals each one for a browser (Web Push encryption) and leaves
-- it here with a send time. The server can't open them; it only forwards them to the browser's push service.
create table if not exists push_device (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create table if not exists push_note (
  device_id text not null references push_device(id) on delete cascade,
  workspace text not null,
  send_at timestamptz not null,
  body bytea not null
);
create index if not exists push_note_due on push_note (send_at);
create index if not exists push_note_device on push_note (device_id, workspace);
-- The server's own push identity (VAPID), made on first use so there's nothing to configure.
create table if not exists push_vapid (
  id integer primary key check (id = 1),
  public_key text not null,
  private_key jsonb not null
);
-- Paid plans through Razorpay (actions/billing.ts). A row per Razorpay subscription, or per Founding order
-- (term 'founding'). paid_until: how far it's paid for; the plan counts until then (lib/plans.ts entitle).
create table if not exists billing_sub (
  id text primary key,
  user_id text not null references "user"(id) on delete cascade,
  plan text not null check (plan in ('plus', 'team')),
  term text not null check (term in ('month', 'half', 'year', 'founding')),
  seats integer not null default 1,
  status text not null default 'created',
  upfront integer not null default 0,
  start_at timestamptz,
  paid_until timestamptz,
  cancel_at_end boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists billing_sub_user on billing_sub (user_id);
-- Every charge, kept for receipts and tax records even after the account is deleted (hence the copied email).
create sequence if not exists billing_invoice_seq;
create table if not exists billing_payment (
  id text primary key,
  user_id text references "user"(id) on delete set null,
  email text not null,
  sub_id text,
  amount integer not null,
  refunded integer not null default 0,
  what text not null,
  invoice_no text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists billing_payment_user on billing_payment (user_id);
-- Webhook deliveries already handled (Razorpay retries), and Razorpay plan ids made on first use.
create table if not exists billing_event (id text primary key, at timestamptz not null default now());
create table if not exists billing_plan (key text primary key, razorpay_id text not null);
`;
