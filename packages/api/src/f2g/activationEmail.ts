/**
 * The activation code e-mail, and the per-channel sender identity behind it (F2G plan 2.4).
 *
 * WHAT THE PARTNER CAN CHANGE, AND WHAT THEY CANNOT. The display NAME is the partner's — mail from
 * the Association's portal should say the Association, not Roam. The from-ADDRESS stays Roam's
 * verified Brevo sender: a partner's own domain would need SPF/DKIM delegation and Brevo sender
 * verification before it could be used, and sending from an unverified domain is the fastest way to
 * land the one e-mail that matters in a spam folder. So `channelSender` swaps the name and leaves
 * the address alone, deliberately, until domain verification is a thing we have done rather than a
 * thing we have assumed.
 *
 * Every interpolated value is escaped. Business names come from a partner's own CRM, which is to say
 * from text nobody at Roam has reviewed.
 */
import type { EmailSender } from "../brevo/transactional.js";

/**
 * The sender for mail sent on a channel's behalf. `orgName` is the partner's own legal/trading name
 * where it differs from the storefront's; falling back to the channel name, then to Roam's own,
 * means an unbranded channel is never left with an empty From.
 */
export function channelSender(
  base: EmailSender,
  channel: { name?: string | null; orgName?: string | null } | null,
): EmailSender {
  const name = (channel?.orgName ?? channel?.name ?? "").trim();
  return name ? { email: base.email, name } : base;
}

export interface ActivationEmailArgs {
  /** The business as the roster names it — used to say which listing this is about. */
  sourceName: string;
  /** The six-digit code. Rendered spaced for legibility and repeated as plain text. */
  code: string;
  /** Minutes until it expires, so the recipient knows to act now rather than tomorrow. */
  expiresInMinutes: number;
  /** The organisation's name, for "…on behalf of <org>". */
  channelName: string;
}

export function renderActivationEmail(args: ActivationEmailArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const { sourceName, code, expiresInMinutes, channelName } = args;
  const safeName = sourceName.trim() || "there";

  const subject = `${code} is your ${channelName} activation code`;

  const text = [
    `Hi ${safeName},`,
    "",
    `Your ${channelName} activation code is: ${code}`,
    "",
    `It expires in ${expiresInMinutes} minutes.`,
    "",
    "Enter it on the activation page to take control of your listing.",
    "",
    "If you didn't ask for this, you can ignore this email — nothing changes until the code is used,",
    "and it will expire on its own.",
  ].join("\n");

  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
  <p>Hi ${escapeHtml(safeName)},</p>
  <p>Your <strong>${escapeHtml(channelName)}</strong> activation code is:</p>
  <p style="margin:24px 0;font-size:30px;font-weight:700;letter-spacing:.28em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(code)}</p>
  <p>It expires in ${escapeHtml(String(expiresInMinutes))} minutes. Enter it on the activation page to take control of your listing.</p>
  <p style="color:#6b7280;font-size:13px">If you didn&rsquo;t ask for this, you can ignore this email — nothing changes until the code is used, and it will expire on its own.</p>
</div>`.trim();

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
