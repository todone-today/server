// Sharing one task by link with people who have no account. The owner agreed (in the app) that a shared task is NOT
// end-to-end encrypted: the browser sends a readable copy here, which guests see and comment on. The encrypted
// original stays in its list. The token is the only key: rotating or revoking it ends access at once.
import { randomBytes } from "node:crypto";
import { ApiError, bad } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { type Task, validTasks } from "@todone/sdk/tasks";
import { type FileRow, confirm, dropFiles, link, newFile } from "./files.ts";

export type Share = { id: string; token: string; workspace: string; owner: string; task: Task };
const token = () => randomBytes(32).toString("base64url");

// The readable copy: the task's own fields and steps, without anything private-only.
function copy(x: unknown): Task {
  const t = x as Task;
  const clean: Task = {
    id: t?.id,
    title: t?.title,
    done: !!t?.done,
    ...(t?.due ? { due: t.due } : {}),
    ...(t?.at ? { at: t.at } : {}),
    ...(t?.est ? { est: t.est } : {}),
    ...(t?.pri ? { pri: t.pri } : {}),
    ...(t?.rep ? { rep: t.rep } : {}),
    ...(t?.note ? { note: t.note } : {}),
    sub: (t?.sub ?? []).map((s) => ({ id: s.id, title: s.title, done: !!s.done, sub: [] })),
  };
  if (!validTasks([clean])) throw bad("That task can't be shared as it is.");
  return clean;
}

// Someone in the share's workspace (its owner, or a teammate in that team).
async function mine(id: string) {
  const { user } = await who();
  const { rows } = await db.query<Share>(
    `select s.* from task_share s where s.id = $1 and (s.workspace = 'u:' || $2
       or s.workspace in (select 'o:' || "organizationId" from member where "userId" = $2))`,
    [id, user],
  );
  if (!rows[0]) throw new ApiError(404, "Not found");
  return { share: rows[0], user };
}

// How many comments guests have left on each shared task the signed-in person can see: the app badges the new ones.
export async function guestCounts() {
  const { user } = await who();
  const { rows } = await db.query<{ id: string; n: number }>(
    `select s.id, count(c.id)::int as n from task_share s
       join share_comment c on c.share_id = s.id and c.guest_no is not null
      where s.workspace = 'u:' || $1 or s.workspace in (select 'o:' || "organizationId" from member where "userId" = $1)
      group by s.id`,
    [user],
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

export async function createShare(task: unknown) {
  const { user, workspace } = await who();
  const t = copy(task);
  const id = crypto.randomUUID();
  const tok = token();
  await db.query(`insert into task_share (id, token, workspace, owner, task) values ($1, $2, $3, $4, $5)`, [
    id,
    tok,
    workspace,
    user,
    JSON.stringify(t),
  ]);
  return { id, token: tok };
}

// New task fields from the app. The shared attachments are the share's own: kept as they are, or set from `files`
// (ids of files uploaded to this share), never taken from the browser's task.
export async function updateShare(id: string, task: unknown, files?: unknown) {
  const { share } = await mine(id);
  let refs = share.task.files;
  if (Array.isArray(files)) {
    const ids = files.filter((x): x is string => typeof x === "string").slice(0, 50);
    const { rows } = await db.query<FileRow>(`select * from file where share_id = $1 and confirmed and id = any($2)`, [
      id,
      ids,
    ]);
    refs = rows.map((f) => ({ id: f.id, name: f.name, type: f.type, size: Number(f.size) }));
  }
  const next = { ...copy(task), ...(refs?.length ? { files: refs } : {}) };
  await db.query(`update task_share set task = $2, updated_at = now() where id = $1`, [id, JSON.stringify(next)]);
}

// A new link; the old one stops working straight away.
export async function rotateShare(id: string) {
  await mine(id);
  const tok = token();
  await db.query(`update task_share set token = $2, updated_at = now() where id = $1`, [id, tok]);
  await db.query(`delete from share_guest where share_id = $1`, [id]);
  return { token: tok };
}

// Stop sharing: the link dies, the readable copy, its conversation and media are deleted.
export async function revokeShare(id: string) {
  await mine(id);
  const { rows } = await db.query<FileRow>(`select * from file where share_id = $1`, [id]);
  await db.query(`delete from task_share where id = $1`, [id]);
  await dropFiles(rows);
}

type Comment = {
  id: string;
  parent_id: string | null;
  author_user: string | null;
  author_name: string | null;
  guest_no: number | null;
  body: string;
  files: unknown[];
  created_at: Date;
};
export async function thread(share: Share, viewer: { user?: string; guest?: number }) {
  const { rows } = await db.query<Comment>(
    `select c.id::text, c.parent_id::text, c.author_user, u.name as author_name, c.guest_no, c.body, c.files, c.created_at
     from share_comment c left join "user" u on u.id = c.author_user
     where c.share_id = $1 order by c.created_at`,
    [share.id],
  );
  return rows.map((c) => ({
    id: c.id,
    parent: c.parent_id,
    who: c.guest_no ? "Anonymous" : c.author_name || "Owner",
    guest: !!c.guest_no,
    mine: c.author_user ? c.author_user === viewer.user : c.guest_no === viewer.guest && !!viewer.guest,
    at: +c.created_at,
    body: c.body,
    files: c.files,
  }));
}

// A comment, with files already uploaded to this share.
export async function addComment(share: Share, b: Record<string, unknown>, author: { user?: string; guest?: number }) {
  const body = typeof b.body === "string" ? b.body.trim().slice(0, 4000) : "";
  const ids = Array.isArray(b.files) ? b.files.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  if (!body && !ids.length) throw bad("Write something or attach a file.");
  const files = ids.length
    ? (
        await db.query<FileRow>(`select * from file where share_id = $1 and confirmed and id = any($2)`, [share.id, ids])
      ).rows.map((f) => ({ id: f.id, name: f.name, type: f.type, size: Number(f.size) }))
    : [];
  const parent = typeof b.parent === "string" && /^\d+$/.test(b.parent) ? b.parent : null;
  if (parent) {
    const p = await db.query(`select 1 from share_comment where id = $1 and share_id = $2 and parent_id is null`, [
      parent,
      share.id,
    ]);
    if (!p.rowCount) throw bad("That reply has nothing to reply to.");
  }
  await db.query(
    `insert into share_comment (share_id, parent_id, author_user, guest_no, body, files) values ($1, $2, $3, $4, $5, $6)`,
    [share.id, parent, author.user ?? null, author.guest ?? null, body, JSON.stringify(files)],
  );
}

async function shareFile(share: Share, fileId: string) {
  const { rows } = await db.query<FileRow>(`select * from file where id = $1 and share_id = $2`, [fileId, share.id]);
  if (!rows[0]) throw new ApiError(404, "Not found");
  return rows[0];
}
export const shareUpload = (share: Share, b: Record<string, unknown>) => newFile(share.workspace, b, share.id);
export const shareConfirm = async (share: Share, fileId: string) => confirm(await shareFile(share, fileId));
export const shareLink = async (share: Share, fileId: string) => link(await shareFile(share, fileId));

// Owner-side wrappers.
export async function ownerView(id: string) {
  const { share, user } = await mine(id);
  return { token: share.token, task: share.task, comments: await thread(share, { user }) };
}
export async function ownerComment(id: string, b: Record<string, unknown>) {
  const { share, user } = await mine(id);
  await addComment(share, b, { user });
}
export const ownerUpload = async (id: string, b: Record<string, unknown>) => shareUpload((await mine(id)).share, b);
export const ownerConfirm = async (id: string, f: string) => shareConfirm((await mine(id)).share, f);
export const ownerLink = async (id: string, f: string) => shareLink((await mine(id)).share, f);

// Guests: the token alone. Each browser sends a random key and gets a number in this share ("Guest 2").
export async function byToken(tok: string) {
  if (!/^[\w-]{40,60}$/.test(tok)) throw new ApiError(404, "This link doesn't work any more.");
  const { rows } = await db.query<Share>(`select * from task_share where token = $1`, [tok]);
  if (!rows[0]) throw new ApiError(404, "This link doesn't work any more.");
  return rows[0];
}
export async function guestNo(share: Share, key: unknown, make: boolean): Promise<number | undefined> {
  if (typeof key !== "string" || !/^[\w-]{16,64}$/.test(key))
    return make ? Promise.reject(bad("Missing guest key")) : undefined;
  const have = await db.query<{ no: number }>(`select no from share_guest where share_id = $1 and guest_key = $2`, [
    share.id,
    key,
  ]);
  if (have.rows[0] || !make) return have.rows[0]?.no;
  const { rows } = await db.query<{ no: number }>(
    `insert into share_guest (share_id, guest_key, no)
     values ($1, $2, (select coalesce(max(no), 0) + 1 from share_guest where share_id = $1))
     on conflict do nothing returning no`,
    [share.id, key],
  );
  return rows[0]?.no ?? (await guestNo(share, key, false));
}
export async function guestView(tok: string, key: unknown) {
  const share = await byToken(tok);
  const guest = await guestNo(share, key, false);
  return { task: share.task, comments: await thread(share, { guest }) };
}
