import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { canEmail, sendEmail } from "./email.ts";

// The Google account the Calendar integration links to (offline: so syncing works while you're away). Not a way to
// make an account: with end-to-end encryption, only the password can open your lists.
const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          accessType: "offline" as const,
          prompt: "select_account consent" as const,
          disableSignUp: true,
        },
      }
    : undefined;

// Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
export const auth = betterAuth({
  database: db,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Forgot password: a link that opens the web app's /reset-password with a one-time token.
    sendResetPassword: canEmail
      ? async ({ user, url }) =>
          sendEmail(user.email, "Reset your todone password", {
            lead: "Someone (hopefully you) asked to reset the password for your todone account. Your lists are end-to-end encrypted, so you'll need your recovery key to keep them.",
            action: "Choose a new password",
            url,
            after:
              "The link works for an hour. If you didn't ask for this, ignore this email; your password stays the same.",
          })
      : undefined,
  },
  // Sign-up sends a link to confirm the email. People can use todone meanwhile; accounts still unconfirmed after
  // seven days are deleted (purgeUnverified). Off when the server can't send email.
  emailVerification: canEmail
    ? {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) =>
          sendEmail(user.email, "Confirm your email for todone", {
            lead: `Welcome to todone${user.name ? `, ${user.name}` : ""}! Confirm this is your email to keep your account.`,
            action: "Confirm my email",
            url,
            after: "Accounts that aren't confirmed within 7 days are deleted. If you didn't sign up, ignore this email.",
          }),
      }
    : undefined,
  databaseHooks: {
    user: {
      create: {
        // A profile picture from Gravatar when the sign-up didn't bring one (GitHub and Google do).
        before: async (user) => ({ data: { ...user, image: user.image || gravatar(user.email) } }),
      },
    },
  },
  user: {
    // End-to-end encryption keys, made in the browser and sent with sign-up (see actions/keys.ts). Ciphertext and a
    // public key only; never returned with the session (GET /api/keys hands them back).
    additionalFields: {
      kdfSalt: { type: "string", required: false, input: true, returned: false },
      kdfIter: { type: "number", required: false, input: true, returned: false },
      wrappedKey: { type: "string", required: false, input: true, returned: false },
      recoveryWrappedKey: { type: "string", required: false, input: true, returned: false },
      encryptedRecovery: { type: "string", required: false, input: true, returned: false },
      publicKey: { type: "string", required: false, input: true, returned: false },
      wrappedPrivateKey: { type: "string", required: false, input: true, returned: false },
    },
    deleteUser: {
      enabled: true,
      // A team someone else still uses needs an owner, so the only owner hands it over (or deletes it) first;
      // teams with no one else in them go with the account.
      beforeDelete: async (user) => {
        const rows = await ownedTeams(user.id);
        const stuck = rows.find((o) => o.members > 1 && o.owners === 1);
        if (stuck)
          throw new APIError("BAD_REQUEST", {
            message: `You're the only owner of “${stuck.name}”. Make someone else an owner or delete the team first.`,
          });
        await dropSoloTeams(user.id);
      },
      // Lists, sessions, memberships and push devices go with the user row; these are keyed by workspace.
      afterDelete: async (user) => dropWorkspace(`u:${user.id}`),
    },
  },
  socialProviders: { ...google },
  // Slows down password guessing and email flooding. Counted in the database so every server instance agrees.
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 3600, max: 10 },
      "/request-password-reset": { window: 3600, max: 5 },
      "/send-verification-email": { window: 3600, max: 5 },
      "/change-password": { window: 3600, max: 10 },
      "/delete-user": { window: 3600, max: 10 },
    },
  },
  // A calendar can live on a Google account with a different email than the todone login.
  account: { accountLinking: { allowDifferentEmails: true } },
  // ponytail: no email service yet, so invitations are shared as a link the inviter copies.
  plugins: [
    organization({
      organizationHooks: {
        // A team's lists go with it (foreign keys); its integration secrets and links must go too.
        afterDeleteOrganization: async ({ organization: o }) => {
          const ws = `o:${o.id}`;
          await db.query(`delete from calendar_share where workspace = $1`, [ws]);
          await db.query(`delete from sync_map where workspace = $1`, [ws]);
          await db.query(`delete from workspace where id = $1`, [ws]);
        },
      },
    }),
  ],
});

export const gravatar = (email: string) =>
  `https://gravatar.com/avatar/${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}?s=160&d=404`;

function ownedTeams(userId: string) {
  return db
    .query<{ id: string; name: string; members: number; owners: number }>(
      `select o.id, o.name,
         (select count(*) from member x where x."organizationId" = o.id)::int as members,
         (select count(*) from member x where x."organizationId" = o.id and x.role = 'owner')::int as owners
       from organization o join member m on m."organizationId" = o.id
       where m."userId" = $1 and m.role = 'owner'`,
      [userId],
    )
    .then((r) => r.rows);
}

async function dropSoloTeams(userId: string) {
  for (const o of (await ownedTeams(userId)).filter((o) => o.members === 1)) await dropWorkspace(`o:${o.id}`, o.id);
}

// Deletes accounts that never confirmed their email within seven days: their solo teams, workspace settings and
// the user row (lists, sessions and memberships go with it). Only where the server sends confirmation emails.
export async function purgeUnverified(): Promise<number> {
  if (!canEmail) return 0;
  const { rows } = await db.query<{ id: string }>(
    `select id from "user" where "emailVerified" = false and "createdAt" < now() - interval '7 days'`,
  );
  for (const { id } of rows) {
    await dropSoloTeams(id);
    await dropWorkspace(`u:${id}`);
    await db.query(`delete from "user" where id = $1`, [id]);
  }
  return rows.length;
}

async function dropWorkspace(ws: string, orgId?: string) {
  await db.query(`delete from calendar_share where workspace = $1`, [ws]);
  await db.query(`delete from sync_map where workspace = $1`, [ws]);
  await db.query(`delete from workspace where id = $1`, [ws]);
  if (orgId) await db.query(`delete from organization where id = $1`, [orgId]);
}

export const hasGithub = false;
export const verifiesEmail = canEmail;
export const hasGoogle = !!google;
