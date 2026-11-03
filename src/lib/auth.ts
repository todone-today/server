import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
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
  user: {
    deleteUser: {
      enabled: true,
      // A team someone else still uses needs an owner, so the only owner hands it over (or deletes it) first;
      // teams with no one else in them go with the account.
      beforeDelete: async (user) => {
        const { rows } = await db.query<{ id: string; name: string; members: number; owners: number }>(
          `select o.id, o.name,
             (select count(*) from member x where x."organizationId" = o.id)::int as members,
             (select count(*) from member x where x."organizationId" = o.id and x.role = 'owner')::int as owners
           from organization o join member m on m."organizationId" = o.id
           where m."userId" = $1 and m.role = 'owner'`,
          [user.id],
        );
        const stuck = rows.find((o) => o.members > 1 && o.owners === 1);
        if (stuck)
          throw new APIError("BAD_REQUEST", {
            message: `You're the only owner of “${stuck.name}”. Make someone else an owner or delete the team first.`,
          });
        for (const o of rows.filter((o) => o.members === 1)) await dropWorkspace(`o:${o.id}`, o.id);
      },
      // Lists, sessions, memberships and push devices go with the user row; these are keyed by workspace.
      afterDelete: async (user) => dropWorkspace(`u:${user.id}`),
    },
  },
  socialProviders: { ...github, ...google },
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

async function dropWorkspace(ws: string, orgId?: string) {
  await db.query(`delete from calendar_share where workspace = $1`, [ws]);
  await db.query(`delete from sync_map where workspace = $1`, [ws]);
  await db.query(`delete from workspace where id = $1`, [ws]);
  if (orgId) await db.query(`delete from organization where id = $1`, [orgId]);
}

export const hasGithub = !!github;
export const hasGoogle = !!google;
