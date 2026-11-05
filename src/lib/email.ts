// Sends todone's emails through Resend (resend.com), with a plain fetch. Without RESEND_API_KEY there is no email:
// verification and password reset by email are switched off, which suits self-hosting and local development.
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM ?? "todone <hello@todone.today>";

export const canEmail = !!KEY;

export async function sendEmail(
  to: string,
  subject: string,
  body: { lead: string; action: string; url: string; after: string },
) {
  if (!KEY) throw new Error("Email isn't set up on this server (RESEND_API_KEY).");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html: html(body),
      text: `${body.lead}\n\n${body.action}: ${body.url}\n\n${body.after}\n\n— todone · todone.today`,
    }),
  });
  if (!r.ok) throw new Error(`Resend said ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// One sticker-style email: cream page, a lime note with a black keyline, one button.
function html({ lead, action, url, after }: { lead: string; action: string; url: string; after: string }) {
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#fff8ef;font-family:Helvetica,Arial,sans-serif;color:#0b0b0b">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto"><tr><td>
<p style="font:900 28px/1 Impact,'Arial Narrow',sans-serif;letter-spacing:-0.5px;text-transform:uppercase;margin:0 0 24px">&#9745; todone</p>
<div style="background:#d4f04a;border:3px solid #0b0b0b;box-shadow:6px 6px 0 #0b0b0b;padding:28px">
<p style="font-size:17px;line-height:1.5;margin:0 0 24px">${esc(lead)}</p>
<a href="${esc(url)}" style="display:inline-block;background:#0b0b0b;color:#d4f04a;font-weight:700;font-size:16px;padding:14px 22px;text-decoration:none;border:3px solid #0b0b0b">${esc(action)}</a>
</div>
<p style="font-size:13px;line-height:1.5;color:#4a4540;margin:24px 0 0">${esc(after)}</p>
<p style="font-size:13px;color:#4a4540;margin:16px 0 0">todone · <a href="https://todone.today" style="color:#0b0b0b">todone.today</a></p>
</td></tr></table></body></html>`;
}
