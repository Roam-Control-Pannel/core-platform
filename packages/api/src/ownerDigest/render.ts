/**
 * Owner digest email — pure rendering. Turns a set of activity lines (each already server-authored
 * as a notification `payload.text`) into the subject + HTML + plain-text of the daily owner email.
 *
 * Styling mirrors the account-lifecycle templates in supabase/email-templates: table-based layout,
 * inline styles, web-safe system-sans, the Roam crimson + warm paper palette — the only combination
 * that renders consistently across Gmail/Outlook/Apple Mail. No web fonts (email can't load Archivo).
 */
export interface DigestItem {
  text: string;
  /** Absolute URL to the thing that happened, or null. */
  url: string | null;
}

export interface DigestEmailInput {
  ownerFirstName?: string | null;
  items: DigestItem[];
  dashboardUrl: string;
  unsubscribeUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const PAPER = "#F6F3EF";
const CARD = "#FFFFFF";
const INK = "#1A1714";
const INK_2 = "#4D463F";
const MUTED = "#857C72";
const FAINT = "#AAA093";
const LINE = "#E4DED6";
const CRIMSON = "#C2123F";
const CRIMSON_700 = "#9D0F33";

/** Minimal HTML-escape for text interpolated into the email body. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderOwnerDigestEmail(input: DigestEmailInput): RenderedEmail {
  const n = input.items.length;
  const subject = `${n} new update${n === 1 ? "" : "s"} on your Roam business`;
  const greeting = input.ownerFirstName ? `Hi ${input.ownerFirstName},` : "Hi,";

  const rows = input.items
    .map((it) => {
      const line = esc(it.text);
      const inner = it.url
        ? `<a href="${esc(it.url)}" style="color:${INK};text-decoration:none;">${line}</a>`
        : line;
      return `
        <tr>
          <td style="padding:14px 0;border-top:1px solid ${LINE};font-size:15px;line-height:1.45;color:${INK};font-family:${SANS};">
            <span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:${CRIMSON};vertical-align:middle;margin-right:10px;"></span>${inner}
          </td>
        </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:${PAPER};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:${CARD};border:1px solid ${LINE};border-radius:16px;overflow:hidden;font-family:${SANS};">
        <tr><td style="height:6px;background:${CRIMSON};"></td></tr>
        <tr><td style="padding:28px 28px 4px;">
          <div style="font-size:20px;font-weight:700;color:${INK};letter-spacing:-.02em;">Roam</div>
          <h1 style="margin:16px 0 4px;font-family:${SANS};font-weight:700;font-size:22px;line-height:1.25;color:${INK};">Here's what's new on your business</h1>
          <p style="margin:0;font-size:14px;color:${INK_2};">${esc(greeting)} you've got ${n} new update${n === 1 ? "" : "s"} since yesterday.</p>
        </td></tr>
        <tr><td style="padding:12px 28px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
        <tr><td style="padding:22px 28px 28px;">
          <a href="${esc(input.dashboardUrl)}" style="display:inline-block;background:${CRIMSON};color:#FFFFFF;font-family:${SANS};font-weight:700;font-size:15px;text-decoration:none;padding:12px 22px;border-radius:999px;">Open your dashboard</a>
        </td></tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;font-size:11px;color:${FAINT};font-family:${SANS};line-height:1.5;">
        You're getting this because you own a business on Roam.
        <a href="${esc(input.unsubscribeUrl)}" style="color:${MUTED};">Unsubscribe from these emails</a>.
      </p>
      <p style="max-width:480px;margin:6px auto 0;font-size:11px;color:${FAINT};font-family:${SANS};">
        Roam · discover your locality · <a href="https://www.roam-local.com" style="color:${CRIMSON_700};">roam-local.com</a>
      </p>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${greeting}`,
    ``,
    `Here's what's new on your Roam business (${n} update${n === 1 ? "" : "s"}):`,
    ...input.items.map((it) => `• ${it.text}${it.url ? ` — ${it.url}` : ""}`),
    ``,
    `Open your dashboard: ${input.dashboardUrl}`,
    ``,
    `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
}
