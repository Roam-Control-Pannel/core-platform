/**
 * Brevo (formerly Sendinblue) contacts API — a minimal client for marketing-list sync.
 *
 * Roam adds people to Brevo lists at two moments: a new user joins the new-users list, and a
 * business owner joins the businesses list when their claim is approved. Both are BEST-EFFORT
 * side effects — Brevo being down, slow, or misconfigured must never break a signup or a claim,
 * so every call here swallows its errors (logs, returns false) and never throws.
 *
 * Auth is the Brevo v3 API key (header `api-key`) — a server-only secret, distinct from the
 * SMTP key used for transactional sending. When the key is absent the client is a no-op, so the
 * API runs fine before the key is provisioned.
 */
const BREVO_CONTACTS_URL = "https://api.brevo.com/v3/contacts";

/**
 * Upsert a contact and add them to one list. Idempotent and additive: `updateEnabled` means an
 * existing contact is updated rather than rejected, and adding `listIds` does NOT remove them
 * from other lists — so a user already on the new-users list who later claims a business ends
 * up on BOTH lists. Returns true on a 2xx, false on any failure (never throws).
 */
export async function upsertBrevoContact(
  apiKey: string | null,
  email: string,
  listId: number,
  attributes?: Record<string, string>,
): Promise<boolean> {
  if (!apiKey) {
    console.warn("[brevo] BREVO_API_KEY not set — skipping contact sync");
    return false;
  }
  const cleaned = email.trim().toLowerCase();
  if (!cleaned) return false;

  try {
    const res = await fetch(BREVO_CONTACTS_URL, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        email: cleaned,
        listIds: [listId],
        updateEnabled: true,
        ...(attributes ? { attributes } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[brevo] contact upsert failed (${res.status}) for list ${listId}: ${body.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[brevo] contact upsert threw:", err);
    return false;
  }
}
