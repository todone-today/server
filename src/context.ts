import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "@vercel/functions";

// The request being handled, so code deep in a call (who's signed in, the browser) can read it without
// passing it down. Set once per request in app.ts.
export const request = new AsyncLocalStorage<Headers>();

export function requestHeaders(): Headers {
  const h = request.getStore();
  if (!h) throw new Error("No request");
  return h;
}

// Work that shouldn't hold up the response (syncing, notifications). On Vercel it keeps the function alive
// until it's done; on a long-running server it just runs.
export function later(work: () => Promise<unknown>) {
  waitUntil(work().catch((e) => console.error(e)));
}

// An error the client should see, with its HTTP status; anything else is a 500.
export class ApiError extends Error {
  status: 400 | 401 | 403 | 404;
  constructor(status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.status = status;
  }
}
export const bad = (message: string) => new ApiError(400, message);
