/**
 * Brevo transactional email — a minimal sender for app-authored mail (the owner activity digest).
 *
 * Sibling to ./client.ts (which only syncs marketing-list contacts). Roam's account lifecycle mail
 * (sign-up, magic link, …) is sent by Supabase Auth over Brevo SMTP; this is the ONE place app code
 * sends its own mail, via Brevo's v3 transactional endpoint. Auth is the same v3 `api-key` header the
 * contacts client uses (the "SMTP key" is a separate relay credential, used only by Supabase).
 *
 * BEST-EFFORT: a send failure (Brevo down, key absent, bad sender) is logged and returns false,
 * never throws — a mail hiccup must never crash the digest job or fail its run for other owners.
 */
const BREVO_SMTP_URL = "https://api.brevo.com/v3/smtp/email";

export interface TransactionalEmail {
  toEmail: string;
  toName?: string | undefined;
  subject: string;
  htmlContent: string;
  /** Optional plain-text alternative; Brevo derives one from the HTML when omitted. */
  textContent?: string | undefined;
}

export interface EmailSender {
  email: string;
  name: string;
}

/**
 * Send one transactional email. Returns true on a 2xx, false on any failure (never throws).
 * A null apiKey makes this a no-op (returns false) so the API/job run before the key is provisioned.
 */
export async function sendTransactionalEmail(
  apiKey: string | null,
  sender: EmailSender,
  email: TransactionalEmail,
): Promise<boolean> {
  if (!apiKey) {
    console.warn("[brevo] BREVO_API_KEY not set — skipping transactional send");
    return false;
  }
  const to = email.toEmail.trim().toLowerCase();
  if (!to) return false;

  try {
    const res = await fetch(BREVO_SMTP_URL, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: sender.email, name: sender.name },
        to: [email.toName ? { email: to, name: email.toName } : { email: to }],
        subject: email.subject,
        htmlContent: email.htmlContent,
        ...(email.textContent ? { textContent: email.textContent } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[brevo] transactional send failed (${res.status}) to ${to}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[brevo] transactional send threw:", err);
    return false;
  }
}
