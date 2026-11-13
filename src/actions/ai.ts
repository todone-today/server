// Ask todone: someone types or speaks their plans; Gemini turns them into lists, goals and rewards in the Markdown the
// app reads (sdk plan.ts), and the app shows them for review before anything is saved (encrypted, in the browser).
//
// Speech goes through todone's own transcriber (worker/, on a machine that polls for jobs): the browser uploads the
// recording, the worker claims it, sends back the words, and the recording is deleted. Jobs are rows here; nothing is
// kept once reviewed, and anything left is swept after an hour. Lists stay end-to-end encrypted: the browser sends
// only list, goal and reward names for context, and saves what comes back itself.
import { timingSafeEqual } from "node:crypto";
import { parsePlan, planPrompt } from "@todone/sdk/plan";
import { ApiError, bad, later, needsPlan } from "../context.ts";
import { who } from "../lib/access.ts";
import { db } from "../lib/db.ts";
import { generate, hasAi } from "../lib/gemini.ts";
import { billingOn } from "../lib/plans.ts";
import { levelOf } from "./billing.ts";

export const FREE_AI = 20;
export const PAID_AI = 300;
export const MAX_TEXT = 8000;
export const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a"];
const WAIT_MINUTES = 10; // a recording no transcriber picked up by then fails

type Context = { today: string; weekday: string; lists: string[]; goals: string[]; rewards: string[] };
const names = (x: unknown, max: number) =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 80)).slice(0, max) : [];
// What the browser says about the person's workspace, cleaned: only names, and today as they see it.
export function context(x: unknown): Context {
  const c = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const today = typeof c.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.today) ? c.today : new Date().toISOString().slice(0, 10);
  const weekday =
    typeof c.weekday === "string" && /^[A-Za-z]{3,9}$/.test(c.weekday)
      ? c.weekday
      : new Date(`${today}T12:00:00Z`).toLocaleDateString("en", { weekday: "long", timeZone: "UTC" });
  return { today, weekday, lists: names(c.lists, 100), goals: names(c.goals, 100), rewards: names(c.rewards, 50) };
}

// This month's allowance: Free 20, any paid plan (and accounts from before plans) 300; none on a server without billing.
const month = () => new Date().toISOString().slice(0, 7);
export const limitFor = (level: string) => (level === "free" ? FREE_AI : PAID_AI);
async function usage(user: string) {
  const limit = billingOn ? limitFor((await levelOf(user)).level) : Infinity;
  const { rows } = await db.query<{ n: number }>(`select n from ai_usage where user_id = $1 and month = $2`, [user, month()]);
  return { used: rows[0]?.n ?? 0, limit };
}
async function mayAsk(user: string) {
  if (!hasAi) throw bad("Ask todone isn't set up on this server.");
  const { used, limit } = await usage(user);
  if (used < limit) return;
  if (limit === FREE_AI) throw needsPlan(`Free includes ${FREE_AI} AI requests a month. Plus has ${PAID_AI}.`);
  throw new ApiError(429, `You've used this month's ${limit} AI requests. “Use your own AI” still works, as much as you like.`);
}
const count = (user: string, tokensIn: number, tokensOut: number) =>
  db.query(
    `insert into ai_usage (user_id, month, n, tokens_in, tokens_out) values ($1, $2, 1, $3, $4)
     on conflict (user_id, month) do update set n = ai_usage.n + 1, tokens_in = ai_usage.tokens_in + $3, tokens_out = ai_usage.tokens_out + $4`,
    [user, month(), tokensIn, tokensOut],
  );

// The AI's answer for these words, checked to hold at least one task, goal or reward, and counted. One retry, on
// the fallback model, for an answer with nothing usable or a request that hung or failed.
async function think(user: string, words: string, c: Context) {
  const system = planPrompt(c);
  for (let i = 0; i < 2; i++) {
    const g = await generate(system, words, i === 1).catch((e) => {
      if (i === 1) throw e;
      return null;
    });
    if (!g) continue;
    const md = g.text.replace(/^```\w*\n?|```\s*$/g, "").trim();
    const p = parsePlan(md, () => "x".repeat(8));
    if (p.lists.length || p.goals.length || p.rewards.length) {
      await count(user, g.tokensIn, g.tokensOut);
      return md;
    }
  }
  throw bad("Couldn't find any tasks in that. Try saying what you need to do.");
}

export async function askText(b: Record<string, unknown>) {
  const { user } = await who();
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) throw bad("Write what you need to do first.");
  if (text.length > MAX_TEXT) throw bad(`That's a lot. Keep it under ${MAX_TEXT} characters.`);
  await mayAsk(user);
  const result = await think(user, text, context(b.context));
  return { result, ...(await usage(user)) };
}

export async function askVoice(audio: ArrayBuffer, type: string, rawContext: string | undefined) {
  const { user } = await who();
  const base = type.split(";")[0].trim().toLowerCase();
  if (!AUDIO_TYPES.includes(base)) throw bad("That recording format isn't supported.");
  if (audio.byteLength < 1000) throw bad("That recording is empty. Try again.");
  await mayAsk(user);
  let c: unknown = null;
  try {
    c = JSON.parse(decodeURIComponent(rawContext ?? ""));
  } catch {}
  const id = crypto.randomUUID();
  await db.query(`insert into ai_job (id, user_id, audio, audio_type, context) values ($1, $2, $3, $4, $5)`, [
    id,
    user,
    Buffer.from(audio),
    base,
    JSON.stringify(context(c)),
  ]);
  return { id };
}

type Job = { status: string; transcript: string | null; result: string | null; error: string | null; created_at: Date };
export async function job(id: string) {
  const { user } = await who();
  // Nobody picked it up in time: say so rather than wait forever.
  await db.query(
    `update ai_job set status = 'failed', audio = null, error = 'Voice is busy right now. Type it instead?'
     where id = $1 and status = 'queued' and created_at < now() - interval '${WAIT_MINUTES} minutes'`,
    [id],
  );
  const { rows } = await db.query<Job>(
    `select status, transcript, result, error, created_at from ai_job where id = $1 and user_id = $2`,
    [id, user],
  );
  const j = rows[0];
  if (!j) throw new ApiError(404, "That request has gone. Try again.");
  return {
    status: j.status,
    waiting: j.status === "queued" ? Math.round((Date.now() - +j.created_at) / 1000) : 0,
    ...(j.transcript ? { transcript: j.transcript } : {}),
    ...(j.result ? { result: j.result, ...(await usage(user)) } : {}),
    ...(j.error ? { error: j.error } : {}),
  };
}

export async function dropJob(id: string) {
  const { user } = await who();
  await db.query(`delete from ai_job where id = $1 and user_id = $2`, [id, user]);
  return { ok: true };
}

export async function myUsage() {
  const { user } = await who();
  const u = await usage(user);
  return { used: u.used, limit: Number.isFinite(u.limit) ? u.limit : null, on: hasAi };
}

// ---- The transcriber (worker/) ----

export function workerOk(header: string | undefined) {
  const token = process.env.AI_WORKER_TOKEN ?? "";
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  return token.length >= 32 && got.length === want.length && timingSafeEqual(got, want);
}

// The oldest recording waiting (or one whose transcriber went quiet), leased for 3 minutes.
export async function claim() {
  const { rows } = await db.query<{ id: string; audio: Buffer; audio_type: string }>(
    `update ai_job set status = 'transcribing', lease_until = now() + interval '3 minutes'
     where id = (select id from ai_job
                 where audio is not null and (status = 'queued' or (status = 'transcribing' and lease_until < now()))
                 order by created_at limit 1 for update skip locked)
     returning id, audio, audio_type`,
  );
  const j = rows[0];
  return j ? { id: j.id, type: j.audio_type, audio: j.audio.toString("base64") } : null;
}

// The words are in: the recording is deleted, and the AI makes the plan in the background.
export async function transcribed(id: string, b: Record<string, unknown>) {
  const words = typeof b.transcript === "string" ? b.transcript.trim().slice(0, MAX_TEXT) : "";
  if (!words) return failed(id, { error: "Didn't catch anything. Try again a little closer to the mic." });
  const { rows } = await db.query<{ user_id: string; context: Context }>(
    `update ai_job set transcript = $2, audio = null, status = 'thinking', lease_until = null
     where id = $1 and status = 'transcribing' returning user_id, context`,
    [id, words],
  );
  const j = rows[0];
  if (!j) return { ok: false };
  later(async () => {
    try {
      const result = await think(j.user_id, words, j.context);
      await db.query(`update ai_job set status = 'ready', result = $2 where id = $1`, [id, result]);
    } catch (e) {
      await db.query(`update ai_job set status = 'failed', error = $2 where id = $1`, [
        id,
        e instanceof Error ? e.message : "Something went wrong.",
      ]);
    }
  });
  return { ok: true };
}

export async function failed(id: string, b: Record<string, unknown>) {
  const error = typeof b.error === "string" && b.error ? b.error.slice(0, 200) : "Couldn't transcribe that. Try again.";
  await db.query(`update ai_job set status = 'failed', audio = null, error = $2 where id = $1 and status <> 'ready'`, [id, error]);
  return { ok: true };
}

// Nothing is kept: jobs go an hour after they were made, reviewed or not.
export async function pruneAi() {
  await db.query(`delete from ai_job where created_at < now() - interval '1 hour'`);
}
