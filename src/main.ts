// Runs the API as a long-lived Node server (Docker, the Mac mini, local development).
import "./instrument.ts";
import { serve } from "@hono/node-server";
import app from "./app.ts";

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port }, () => console.log(`todone server on http://localhost:${port}`));
