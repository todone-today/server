# todone server

The API behind [todone.today](https://todone.today): accounts and teams (Better Auth), lists, integrations (Google Calendar, Notion, Discord, Markdown sync, calendar feed), push reminders and the database migrations. Hono on Node 24, Postgres. Shared logic comes from [@todone/sdk](https://github.com/todone-today/sdk).

```sh
npm install
npm run local   # Postgres in Node (PGlite) + migrations + API on http://localhost:4000
npm test
```

Settings: `.env.example`. Routes: `src/app.ts`. The web app is in [clients](https://github.com/todone-today/clients); setup and architecture are in [contributing-docs](https://github.com/todone-today/contributing-docs).

## Self-hosting

`docker compose up -d --build` runs Postgres, this server, the web app (built straight from the clients repo), a reminders job and, with `--profile tunnel` and `CLOUDFLARE_TUNNEL_TOKEN`, a Cloudflare Tunnel. `.drone.yml` deploys it on a push to `main`.

## Vercel

`npm run vercel-build` bundles the server into one function (`.vercel/output`), which the `todone-server` project deploys.

GPL-3.0, see [LICENSE](LICENSE).
