// Product events from the server to PostHog, for the funnel the landing page starts (web: components/Journey.tsx).
// Anonymous: a fresh random id per event, no person profile, no email or user id. Off without POSTHOG_KEY (the
// project's public key). Fire and forget: an analytics hiccup never fails a payment.
export function event(name: string, props: Record<string, string | number | boolean>) {
  const key = process.env.POSTHOG_KEY;
  if (!key) return;
  fetch("https://us.i.posthog.com/i/v0/e/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: name,
      distinct_id: crypto.randomUUID(),
      properties: { ...props, $process_person_profile: false, source: "server" },
    }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => console.error("posthog", e));
}
