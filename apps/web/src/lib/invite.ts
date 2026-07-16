/**
 * Invite loop plumbing (growth #1). The inviter's @handle is stashed under this key when a visitor
 * lands on /i/<handle>, and consumed by InviteApply once a session exists — so the referral survives
 * the sign-up round-trip (same device). Client-only.
 */
export const INVITED_BY_KEY = "roam:invitedBy";

export function readInvitedBy(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(INVITED_BY_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function clearInvitedBy(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(INVITED_BY_KEY);
  } catch {
    /* private mode */
  }
}
