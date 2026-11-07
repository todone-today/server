// Files (task attachments, shared-task media) live in a private Cloudflare R2 bucket. The server never handles the
// bytes: it checks access, then gives the browser a short-lived signed URL to upload to or download from R2, and
// checks the upload afterwards. Off (no attachments) without the R2_* settings.
import { AwsClient } from "aws4fetch";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
const BUCKET = process.env.R2_BUCKET ?? "todone-files";
export const hasFiles = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const aws = hasFiles
  ? new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY!, service: "s3", region: "auto" })
  : null;
const at = (key: string) => `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${encodeURIComponent(key)}`;
const client = () => {
  if (!aws) throw new Error("File storage isn't set up on this server (R2_*).");
  return aws;
};

// A URL the browser can PUT the file to, or GET it from, for `seconds`. GET can say how to show it (inline or as a
// download, with which name and type).
export async function presign(
  method: "PUT" | "GET",
  key: string,
  seconds: number,
  show?: { type: string; name: string; inline: boolean },
) {
  const u = new URL(at(key));
  u.searchParams.set("X-Amz-Expires", String(seconds));
  if (show) {
    u.searchParams.set("response-content-type", show.type);
    u.searchParams.set(
      "response-content-disposition",
      `${show.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(show.name)}`,
    );
  }
  const signed = await client().sign(new Request(u, { method }), { aws: { signQuery: true } });
  return signed.url;
}

// The stored size, or null when it isn't there.
export async function sizeOf(key: string) {
  const r = await client().fetch(at(key), { method: "HEAD" });
  return r.ok ? Number(r.headers.get("content-length")) : null;
}

export async function firstBytes(key: string, n = 512) {
  const r = await client().fetch(at(key), { headers: { range: `bytes=0-${n - 1}` } });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array();
}

export async function remove(key: string) {
  if (aws) await aws.fetch(at(key), { method: "DELETE" }).catch(() => {});
}
