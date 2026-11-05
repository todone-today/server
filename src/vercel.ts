// Vercel's entry: the same app as main.ts, as a Node request handler for a serverless function.
import { getRequestListener } from "@hono/node-server";
import app from "./app.ts";

export default getRequestListener(app.fetch);
