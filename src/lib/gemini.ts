// Google Gemini over its REST API (no SDK), for Ask todone: turning what someone typed or said into lists, goals and
// rewards. Paid tier only: its terms don't use requests to improve Google's products. Off without GEMINI_API_KEY.
import { bad } from "../context.ts";

const KEY = process.env.GEMINI_API_KEY ?? "";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
// Tried when the main model is busy or hangs (Google sheds load with 503s at peaks).
const FALLBACK = process.env.GEMINI_FALLBACK || "gemini-3.5-flash-lite";
export const hasAi = !!KEY;

const BUSY = "The AI isn't answering right now. Try again in a moment.";

export async function generate(system: string, text: string, fallback = false) {
  const model = fallback ? FALLBACK : MODEL;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch((e) => {
    console.error("gemini", model, e instanceof Error ? e.name : e); // timed out, or unreachable
    throw bad(BUSY);
  });
  const data = (await r.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    error?: { message?: string };
  };
  if (!r.ok) {
    console.error("gemini", model, r.status, data.error?.message);
    throw bad(r.status === 429 ? "The AI is busy (too many requests). Try again in a minute." : BUSY);
  }
  return {
    text: (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
    tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
