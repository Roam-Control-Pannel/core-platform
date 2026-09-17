/**
 * Cookie/analytics consent — the ONE source of truth for "may we load analytics?".
 *
 * ARCHITECTURE.md lists cookie/consent as a hard gate, and until holistic plan Phase 1.3 GA4 loaded
 * unconditionally on every host. The choice lives in a first-party cookie (not localStorage) so a
 * server render can honour it later, and it is broadcast as a DOM event so the Analytics loader can
 * react without a page reload. Nothing here touches the network.
 *
 * Values: "granted" | "denied". Absent = not yet asked (the banner shows; nothing loads).
 */
export const CONSENT_COOKIE = "roam_consent";
export const CONSENT_EVENT = "roam:consent";
const MAX_AGE_S = 60 * 60 * 24 * 365; // a year; re-asked after that

export type ConsentChoice = "granted" | "denied";

export function readConsent(): ConsentChoice | null {
  if (typeof document === "undefined") return null;
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${CONSENT_COOKIE}=([^;]*)`));
    const v = m?.[1];
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

export function writeConsent(choice: ConsentChoice): void {
  if (typeof document === "undefined") return;
  try {
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${CONSENT_COOKIE}=${choice}; Max-Age=${MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
    window.dispatchEvent(new CustomEvent<ConsentChoice>(CONSENT_EVENT, { detail: choice }));
  } catch {
    /* a blocked cookie jar just means we ask again next time */
  }
}

/** Subscribe to consent changes (banner → analytics loader). Returns an unsubscribe. */
export function onConsentChange(cb: (choice: ConsentChoice) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<ConsentChoice>).detail);
  window.addEventListener(CONSENT_EVENT, handler);
  return () => window.removeEventListener(CONSENT_EVENT, handler);
}
