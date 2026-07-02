/**
 * FirstRunProfilePrompt — a one-time, dismissible "finish your profile" modal that captures the
 * two things a fresh account is missing: a display name and a date of birth (which powers the
 * birthday-treats engine). It is the sign-up-time DOB capture, deferred to first AUTHENTICATED
 * load because email sign-up has no session at submit time (email confirm) — so the reliable
 * moment to ask is when the user lands back signed in (or via OAuth).
 *
 * WHY HERE (global chrome): mounted once in the root layout inside TrpcProvider, so it catches
 * every path to an authenticated session — email-confirm return, OAuth callback, and existing
 * DOB-less users on their next visit (a quiet backfill). It reuses the existing privacy-safe
 * storage + write path (profiles.setPersonal → owner-only user_private; profiles.updateMe →
 * display_name) and validation (age 13–120 lives server-side) — no new table or procedure.
 *
 * NON-BLOCKING by design (Roam's browse-freely, auth-on-action ethos): it only appears when a
 * session exists AND the user has no birth_date yet, and "Skip for now" snoozes it per-device
 * (localStorage) so it never nags. Completing it writes birth_date, which is the cross-device
 * source of truth — once set, this never shows again on any device.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

/** How long "Skip for now" hides the prompt on this device before it may re-ask. */
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const snoozeKey = (uid: string) => `roam:profilePrompt:snooze:${uid}`;

/** Today as yyyy-mm-dd, to cap the date input so a future birthday can't be entered. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function FirstRunProfilePrompt() {
  const trpc = useTrpc();
  const session = useSession();
  const userId = session?.user?.id ?? null;

  const [show, setShow] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Decide whether to show: signed in, no birth_date yet, not snoozed on this device.
  useEffect(() => {
    if (!userId) {
      setShow(false);
      return;
    }
    let cancelled = false;
    try {
      const until = Number(localStorage.getItem(snoozeKey(userId)) ?? "0");
      if (until && Date.now() < until) return;
    } catch {
      /* localStorage unavailable (private mode) — fall through and just ask. */
    }
    const personalQ = trpc.profiles.personal as unknown as {
      query: () => Promise<{ birthDate: string | null; birthdayOffersEnabled: boolean }>;
    };
    const meQ = trpc.profiles.me as unknown as {
      query: () => Promise<{ displayName: string | null }>;
    };
    Promise.all([personalQ.query(), meQ.query().catch(() => null)])
      .then(([personal, me]) => {
        if (cancelled) return;
        if (personal.birthDate) return; // already given — never prompt again (cross-device truth)
        setDisplayName(me?.displayName ?? "");
        setEnabled(true);
        setShow(true);
      })
      .catch(() => {
        /* Never block the app on this — a failed read just means no prompt this load. */
      });
    return () => {
      cancelled = true;
    };
  }, [userId, trpc]);

  const dismiss = useCallback(() => {
    try {
      if (userId) localStorage.setItem(snoozeKey(userId), String(Date.now() + SNOOZE_MS));
    } catch {
      /* ignore */
    }
    setShow(false);
  }, [userId]);

  // Escape-to-dismiss + body-scroll lock + focus into the dialog, mirroring AuthModal.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevFocus = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [show, dismiss]);

  const save = useCallback(async () => {
    if (!birthDate) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = displayName.trim();
      if (trimmed) {
        const updateMe = trpc.profiles.updateMe as unknown as {
          mutate: (i: { displayName?: string | null }) => Promise<unknown>;
        };
        await updateMe.mutate({ displayName: trimmed });
      }
      const setPersonal = trpc.profiles.setPersonal as unknown as {
        mutate: (i: { birthDate: string | null; birthdayOffersEnabled: boolean }) => Promise<unknown>;
      };
      await setPersonal.mutate({ birthDate, birthdayOffersEnabled: enabled });
      // Completed — clear any prior snooze and close for good (birth_date now set server-side).
      try {
        if (userId) localStorage.removeItem(snoozeKey(userId));
      } catch {
        /* ignore */
      }
      setShow(false);
    } catch {
      // setPersonal rejects a DOB outside age 13–120 (server-side); surface a gentle nudge.
      setError("That date of birth doesn't look right — please check it and try again.");
    } finally {
      setBusy(false);
    }
  }, [trpc, userId, displayName, birthDate, enabled]);

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="firstrun-title"
      onClick={dismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "start center",
        padding: "var(--space-8) var(--space-3)",
        background: "rgba(20, 14, 16, 0.55)",
        overflowY: "auto",
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, outline: "none" }}
      >
        <Card style={{ padding: "var(--space-5)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "var(--space-2)" }}>
            <Icon name="party" size={22} style={{ color: "var(--crimson)" }} />
            <h2
              id="firstrun-title"
              className="t-h4"
              style={{ fontFamily: "var(--display)", fontWeight: 600, color: "var(--ink)", margin: 0 }}
            >
              Welcome to Roam
            </h2>
          </div>
          <p style={{ margin: "0 0 var(--space-4)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            Two quick things so friends recognise you — and so the places you follow can send you a
            birthday treat.
          </p>

          <label style={{ display: "block", marginBottom: "var(--space-3)" }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
              Your name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={busy}
              maxLength={200}
              placeholder="e.g. Andrew M."
              aria-label="Display name"
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)" }}
            />
          </label>

          <label style={{ display: "block", marginBottom: "var(--space-3)" }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
              Date of birth
            </span>
            <input
              type="date"
              value={birthDate}
              max={todayIso()}
              onChange={(e) => setBirthDate(e.target.value)}
              disabled={busy}
              aria-label="Date of birth"
              style={{ width: "100%", maxWidth: 220, boxSizing: "border-box", padding: "10px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)" }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: "var(--space-3)" }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={busy}
              style={{ marginTop: 3, width: 18, height: 18, accentColor: "var(--crimson)" }}
            />
            <span style={{ fontSize: 13.5, color: "var(--ink)", lineHeight: 1.45 }}>
              Send me birthday treats from places I follow
            </span>
          </label>

          <p style={{ margin: "0 0 var(--space-4)", fontSize: 12, color: "var(--muted)", lineHeight: 1.5, display: "flex", gap: 6 }}>
            <Icon name="lock" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Your birthday is private — businesses never see the date. It&apos;s only used to send the
              treats you&apos;ve opted into. You can change any of this later in Settings.
            </span>
          </p>

          {error ? (
            <p style={{ margin: "0 0 var(--space-3)", fontSize: 13, color: "var(--crimson-700)" }}>{error}</p>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <Button variant="pri" block onClick={() => void save()} disabled={busy || !birthDate}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="neutral" block onClick={dismiss} disabled={busy}>
              Skip for now
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
