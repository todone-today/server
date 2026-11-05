// Prints the latest feedback people sent from the app: npm run feedback [-- 50]
// Uses DATABASE_URL (from .env.local, or e.g. `vercel env pull` for production).
import { db } from "../src/lib/db.ts";

const limit = Math.min(Number(process.argv[2]) || 20, 500);
const { rows } = await db.query<{ at: Date; kind: string; body: string; page: string | null; email: string | null }>(
  `select f."createdAt" as at, f.kind, f.body, f.page, u.email
   from feedback f left join "user" u on u.id = f."userId"
   order by f."createdAt" desc limit $1`,
  [limit],
);
for (const r of rows.reverse())
  console.log(
    `\n[${r.at.toISOString().slice(0, 16).replace("T", " ")}] ${r.kind.toUpperCase()} · ${r.email ?? "?"} · ${r.page ?? ""}\n${r.body}`,
  );
console.log(`\n${rows.length} shown.`);
await db.end();
