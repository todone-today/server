// Attachments. A file row is made first (checked against the type, size and quota rules), the browser uploads the
// bytes straight to R2 with a signed URL, then confirms: the server checks the stored size and, for readable files,
// the first bytes, and deletes anything that doesn't match. Private files are end-to-end encrypted in the browser
// (`enc`): the server only ever sees ciphertext. Shared-task files (`share`) are readable.
import { ApiError, bad } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { ENC_OVERHEAD, SHARE_CAP, TYPES, WORKSPACE_CAP, allowed } from "../lib/filetypes.ts";
import { firstBytes, hasFiles, presign, remove, sizeOf } from "../lib/r2.ts";

export type FileRow = {
  id: string;
  workspace: string;
  share_id: string | null;
  key: string;
  name: string;
  type: string;
  size: number;
  enc: boolean;
  confirmed: boolean;
};
export const fileRef = (f: FileRow) => ({
  id: f.id,
  name: f.name,
  type: f.type,
  size: Number(f.size),
  ...(f.enc ? { enc: true } : {}),
});

const name = (x: unknown) => {
  const n =
    typeof x === "string"
      ? x
          .replace(/[\\/\u0000-\u001f]/g, "")
          .trim()
          .slice(0, 200)
      : "";
  return n || "file";
};

// A new file waiting for its upload. `share`: a shared task's (readable); otherwise private and encrypted.
export async function newFile(workspace: string, b: Record<string, unknown>, share: string | null) {
  if (!hasFiles) throw new ApiError(400, "Attachments aren't set up on this server yet.");
  const type = String(b.type ?? "");
  const size = Number(b.size);
  const why = allowed(type, size);
  if (why) throw bad(why);
  const enc = !share;
  const stored = enc ? size + ENC_OVERHEAD : size;
  const used = share
    ? await db.query<{ n: string }>(`select coalesce(sum(size), 0) n from file where share_id = $1`, [share])
    : await db.query<{ n: string }>(`select coalesce(sum(size), 0) n from file where workspace = $1 and share_id is null`, [
        workspace,
      ]);
  if (Number(used.rows[0].n) + stored > (share ? SHARE_CAP : WORKSPACE_CAP))
    throw bad(share ? "This shared task is full (200 MB)." : "Your attachments are full (1 GB). Delete some first.");
  const id = crypto.randomUUID();
  const key = `${share ? `s/${share}` : `w/${workspace}`}/${id}`;
  await db.query(
    `insert into file (id, workspace, share_id, key, name, type, size, enc) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, workspace, share, key, name(b.name), type, stored, enc],
  );
  return { id, uploadUrl: await presign("PUT", key, 600) };
}

// After the upload: right size, and (readable files) really the type it says. Otherwise it's deleted.
export async function confirm(f: FileRow) {
  if (f.confirmed) return fileRef(f);
  const size = await sizeOf(f.key);
  const ok = size !== null && size <= Number(f.size) && size > 0 && (f.enc || TYPES[f.type]?.magic(await firstBytes(f.key)));
  if (!ok) {
    await remove(f.key);
    await db.query(`delete from file where id = $1`, [f.id]);
    throw bad(
      size === null ? "The upload didn't arrive. Try again." : "That file isn't what it says it is, or it's too big.",
    );
  }
  await db.query(`update file set confirmed = true, size = $2 where id = $1`, [f.id, size]);
  return fileRef({ ...f, size: f.enc ? size - ENC_OVERHEAD : size });
}

// A short-lived link to the file: shown inline (readable images and videos) or as a download.
export async function link(f: FileRow) {
  if (!f.confirmed) throw new ApiError(404, "Not found");
  const inline = !f.enc && !!TYPES[f.type]?.inline;
  return {
    url: await presign("GET", f.key, 300, {
      type: f.enc ? "application/octet-stream" : f.type,
      name: f.name,
      inline,
    }),
  };
}

export async function dropFiles(rows: FileRow[]) {
  for (const f of rows) await remove(f.key);
  if (rows.length) await db.query(`delete from file where id = any($1)`, [rows.map((f) => f.id)]);
}

// Private files (signed in): the active workspace's, end-to-end encrypted.
async function mine(id: string) {
  const { workspace } = await who();
  const { rows } = await db.query<FileRow>(`select * from file where id = $1 and workspace = $2 and share_id is null`, [
    id,
    workspace,
  ]);
  if (!rows[0]) throw new ApiError(404, "Not found");
  return rows[0];
}
export const createFile = async (b: Record<string, unknown>) => newFile((await who()).workspace, b, null);
export const confirmFile = async (id: string) => confirm(await mine(id));
export const fileLink = async (id: string) => link(await mine(id));
export const deleteFile = async (id: string) => dropFiles([await mine(id)]);

// Uploads started but never confirmed (abandoned), after a day.
export async function pruneFiles() {
  const { rows } = await db.query<FileRow>(
    `select * from file where not confirmed and created_at < now() - interval '1 day'`,
  );
  await dropFiles(rows);
}
