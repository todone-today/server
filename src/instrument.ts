// Error reports to Sentry, when SENTRY_DSN is set. Imported first by main.ts so it's ready before the app loads.
// Nothing personal is sent: no request (URLs can carry private calendar and sync tokens), no user, no IPs.
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN)
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      return event;
    },
  });

export { Sentry };
