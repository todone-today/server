import { db } from "./db.ts";

// A per-client limit on the API, counted in Postgres so every server instance shares it (serverless instances
// don't share memory). Fixed windows: simple, and fine at this scale.

type Rule = { name: string; max: number; seconds: number };

// Which rule a request falls under. Sign-in, sign-up and auth emails have Better Auth's own limits (auth.ts).
export function ruleFor(method: string, path: string): Rule | null {
  if (path.startsWith("/api/auth/") || path.startsWith("/api/cron/") || path === "/api/health") return null;
  if (path === "/api/feedback") return { name: "feedback", max: 10, seconds: 3600 };
  // Links that work without signing in, guarded only by their token: slow down anyone guessing tokens.
  if (/^\/api\/(sync|calendar|shared)\//.test(path)) return { name: "links", max: 60, seconds: 60 };
  if (path === "/api/demo") return { name: "demo", max: 30, seconds: 60 };
  if (method !== "GET") return { name: "writes", max: 120, seconds: 60 };
  return { name: "reads", max: 600, seconds: 60 };
}

// The caller's address: the first hop Vercel (or a proxy in front of the Compose setup) recorded.
export function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim();
}

// Counts this request; returns the seconds to wait when over the limit, otherwise null.
export async function hit(rule: Rule, who: string): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const window = now - (now % rule.seconds);
  const { rows } = await db.query<{ count: number }>(
    `insert into rate_limit (key, "window", count) values ($1, $2, 1)
     on conflict (key, "window") do update set count = rate_limit.count + 1 returning count`,
    [`${rule.name}:${who}`, window],
  );
  return rows[0].count > rule.max ? window + rule.seconds - now : null;
}

// Old windows are useless; the cron job and the sign-up clean-up sweep them.
export async function pruneRateLimits() {
  await db.query(`delete from rate_limit where "window" < extract(epoch from now())::bigint - 7200`);
}
