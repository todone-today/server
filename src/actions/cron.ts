import { timingSafeEqual } from "node:crypto";
import { purgeUnverified } from "../lib/auth.ts";
import { pruneRateLimits } from "../lib/rate-limit.ts";
import { pruneFiles } from "./files.ts";
import { pruneAi } from "./ai.ts";

// Called on a schedule (Vercel Cron sends "Authorization: Bearer $CRON_SECRET").
export async function cron(req: Request) {
  const want = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`);
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  if (!process.env.CRON_SECRET || got.length !== want.length || !timingSafeEqual(got, want))
    return new Response("Unauthorized", { status: 401 });
  return Response.json({ purged: await housekeep() });
}

// Sweeps what has expired: old rate-limit counts, unused uploads, finished AI jobs, and accounts never confirmed.
// The long-running server (main.ts) runs it itself every 10 minutes; serverless hosts call /api/cron/notify.
export async function housekeep() {
  await pruneRateLimits();
  await pruneFiles();
  await pruneAi();
  return purgeUnverified();
}
