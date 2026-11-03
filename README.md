# todone server

The API: accounts and teams (Better Auth), lists, integrations (Google Calendar, Notion, Discord, Markdown sync, calendar feed), push reminders, and the database migrations. Hono on Node 24, Postgres.

```sh
npm install
npm run local   # PGlite + migrations + API on http://localhost:4000
npm test
```

Settings: `.env.example`. Routes: `src/app.ts`. Self-hosting: `docker-compose.yml`. See [../contributing-docs](../contributing-docs/README.md).
