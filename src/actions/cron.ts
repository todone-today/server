import { timingSafeEqual } from "node:crypto";
import { purgeUnverified } from "../lib/auth.ts";
import { pruneRateLimits } from "../lib/rate-limit.ts";
import { pruneFiles } from "./files.ts";

// Called on a schedule (Vercel Cron sends "Authorization: Bearer $CRON_SECRET").
export async function cron(req: Request) {
  const want = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`);
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  if (!process.env.CRON_SECRET || got.length !== want.length || !timingSafeEqual(got, want))
    return new Response("Unauthorized", { status: 401 });
  await pruneRateLimits();
  await pruneFiles();
  return Response.json({ purged: await purgeUnverified() });
}
