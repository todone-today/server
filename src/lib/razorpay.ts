// Razorpay over its REST API (no SDK): plans, subscriptions, orders, refunds, and the two signature checks.
// Keys come from the environment; without them billing is off and todone has no plan limits (self-hosting).
import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../context.ts";

const ID = process.env.RAZORPAY_KEY_ID ?? "";
const SECRET = process.env.RAZORPAY_KEY_SECRET ?? "";
export const keyId = ID;
export const hasRazorpay = !!(ID && SECRET);

export async function rzp<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!r.ok) {
    console.error("razorpay", method, path, r.status, data.error?.description);
    throw new ApiError(400, data.error?.description ? `Razorpay: ${data.error.description}` : "Payments are unavailable right now.");
  }
  return data;
}

const hmac = (secret: string, text: string | Buffer) => createHmac("sha256", secret).update(text).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Checkout's success callback: subscriptions sign "payment|subscription", orders sign "order|payment".
export const signs = (secret: string, text: string, signature: unknown) =>
  typeof signature === "string" && same(hmac(secret, text), signature);
export const checkoutOk = (text: string, signature: unknown) => signs(SECRET, text, signature);

// Webhooks sign the raw body with the webhook secret set in the Razorpay dashboard.
export const webhookOk = (raw: string, signature: unknown) =>
  !!process.env.RAZORPAY_WEBHOOK_SECRET && signs(process.env.RAZORPAY_WEBHOOK_SECRET, raw, signature);
