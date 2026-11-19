# Events

Every product event todone sends to PostHog (US cloud, project 493072). Add a row here whenever you add an event.

## Rules for every event

- **Never sent:** task, list, goal or reward names; notes; comments; file names; emails; names; user, team, list or task ids; IP addresses we choose to add; anything typed.
- **No person profiles:** every event sets `$process_person_profile: false`.
- **Anonymous ids:** `distinct_id` is random. The server uses a fresh one per event. The app uses one per visit, kept in memory and gone on reload. The landing page uses posthog-js with `persistence: "memory"`.
- **No cookies to PostHog:** the browser sends to `/ingest`, a rewrite in the web app's `next.config.ts`. `src/proxy.ts` strips `Cookie` and `Authorization` before forwarding.
- **Off without a key:** the server needs `POSTHOG_KEY`; the web app needs `NEXT_PUBLIC_POSTHOG_KEY`. Both hold the project's public key, which can only send events.
- **`source`:** every event carries `source`:
  - `server`: from this repo (`src/lib/events.ts`);
  - `app`: the signed-in app (web `src/lib/usage.ts`);
  - none: the landing page (posthog-js, web `src/components/Journey.tsx`).

## Funnel: landing page → account → paid

| Event | Sent from | Properties | When |
|---|---|---|---|
| `$pageview`, `$pageleave` | landing (posthog-js) | `ref` (launch tag, e.g. `email`) | Visits to the home page only. |
| `section_seen` | landing | `section` (`hero`, `tour`, …), `seconds`, `order` | A part of the home page was the main thing on screen for at least 0.5 s. |
| `signup_cta` | landing | `text` (button label), `section` (or `nav`) | A sign-up or open-the-app button was pressed. |
| `social_start` | landing sign-up form | `provider` (`google`, `github`, `discord`), `mode` (`in` sign in, `up` sign up) | Someone started signing in with a provider (they leave for it). |
| `signed_up` | landing sign-up form | `method: email` | An email sign-up finished in the browser. This is a funnel step tied to the landing visit. For totals, use `account_created`. |
| `account_created` | server, `src/lib/auth.ts` | `method` (`email`, `google`, `github`, `discord`, `other`) | Any new account, whatever way it signed up. Ad blockers can't hide it. **Use this for sign-up totals.** |
| `upgraded` | server, `src/actions/billing.ts` | `what` (plan and term), `amount_inr` | A first payment for a plan was recorded. |
| `renewed` | server, `src/actions/billing.ts` | `what`, `amount_inr` | A later payment on the same plan. |

## Use: inside the app (counts only)

| Event | Sent from (web) | Properties | When |
|---|---|---|---|
| `task_created` | `app/app/TodoApp.tsx`, `AiImport.tsx`, `Brainstorm.tsx` | `via`: `typed` (the add box), `ask` (Ask todone, with `n` tasks), `idea` (from Brainstorm) | Tasks were added. |
| `task_done` | `app/app/TodoApp.tsx` | — | A task or step was ticked done (unticking isn't counted). |
| `list_created` | `lib/store.ts` | — | A list was made (not the Bin, Brainstorm or Goals). The demo is not counted. |
| `ask_used` | `app/app/AiImport.tsx` | `via`: `typed`, `voice` | Ask todone took a request. |

Not tracked: anything in the demo, session recordings or heatmaps inside the app, and which list or task an action happened to.
