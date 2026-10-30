import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { db } from "./db.ts";

const github =
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? { github: { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET } }
    : undefined;
// Google sign-in, and the account the Calendar integration links to (offline: so syncing works while you're away).
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          accessType: "offline" as const,
          prompt: "select_account consent" as const,
        },
      }
    : undefined;

// Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
export const auth = betterAuth({
  database: db,
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  socialProviders: { ...github, ...google },
  // A calendar can live on a Google account with a different email than the todone login.
  account: { accountLinking: { allowDifferentEmails: true } },
  // ponytail: no email service yet, so invitations are shared as a link the inviter copies.
  plugins: [organization(), nextCookies()],
});

export const hasGithub = !!github;
export const hasGoogle = !!google;
