// Creates or updates the tables: Better Auth's, then the app's. Safe to run on every deploy.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../src/lib/auth.ts";
import { db, SCHEMA } from "../src/lib/db.ts";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
await db.query(SCHEMA);
await db.end();
console.log("database is up to date");
