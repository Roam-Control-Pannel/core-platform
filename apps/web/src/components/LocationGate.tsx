/**
 * LocationGate — first-visit location handling, mounted once in the root layout (inside
 * TrpcProvider). Two jobs, both non-blocking (Roam's browse-freely ethos):
 *
 *  1. Cold-start default (permission-free): a SIGNED-OUT visitor with no local place choice opens
 *     Explore near where they are, from the coarse /api/geo IP guess — instead of a hard-coded
 *     town (the "London user lands on Darlington" bug). Signed-in users are left to PlacePrefsSync
 *     (their saved/last place wins); a returning device with a stored choice is never overridden.
 *
 *  2. Contextual precise-location card: while we're only GUESSING the place (source "detected" or
 *     "default"), a small dismissible card invites the visitor to share precise location. Tapping
 *     Allow is a user gesture (higher grant rate than a prompt-on-load) and swaps in GPS coords.
 *     Shown at most once per device (snoozed on dismiss OR on a denied prompt, so it never nags).
 *
 * Renders the card only; job (1) renders nothing.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@roam/design";
import { useSession } from "./TrpcProvider";
import { useCurrentPlace, hasStoredPlace } from "../lib/currentPlace";
import { detectPlaceFromIp } from "../lib/detectPlace";

const SNOOZE_KEY = "roam:locationPrompt:snooze";
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export function LocationGate() {
  const t = useTranslations("locationGate");
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();
  const [show, setShow] = useState(false);
  const [locating, setLocating] = useState(false);
  const bootstrapped = useRef(false);
  // Latest session, read at apply-time. `session` is null on first render for EVERYONE (it
  // populates after getSession resolves), so we can't trust it synchronously — but getSession
  // (a localStorage read) resolves before the /api/geo fetch, so by apply-time this is accurate.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // (1) Cold-start IP default — fresh, signed-out device with no local choice → open near them.
  useEffect(() => {
    if (bootstrapped.current || hasStoredPlace()) return;
    bootstrapped.current = true;
    detectPlaceFromIp()
      .then((p) => {
        // Apply only if it's still a fresh signed-out device: no session appeared and no choice
        // was made while /api/geo was in flight (signed-in users get their place via PlacePrefsSync).
        if (p && !sessionRef.current && !hasStoredPlace()) setPlace(p);
      })
      .catch(() => {});
  }, [setPlace]);

  // (2) Contextual card — only while we're GUESSING the place (no deliberate choice) and
  // geolocation is available. A guess is: the initial seed (DEFAULT_PLACE, no source), the
  // "default" fallback, or an IP "detected" place — never a search/saved/GPS/suggested choice.
  const guessing = !place.source || place.source === "default" || place.source === "detected";
  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    if (!guessing) return;
    try {
      const until = Number(localStorage.getItem(SNOOZE_KEY) ?? "0");
      if (until && Date.now() < until) return;
    } catch {
      /* private mode — just show it */
    }
    setShow(true);
  }, [place.source]);

  const snooze = useCallback(() => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      /* private mode */
    }
    setShow(false);
  }, []);

  const useMyLocation = useCallback(() => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPlace({
          id: "my-location",
          name: t("nearMe"),
          hint: t("yourLocation"),
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          source: "current",
        });
        snooze();
      },
      () => {
        // Denied or failed — don't nag again this device.
        setLocating(false);
        snooze();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }, [t, setPlace, snooze]);

  if (!show) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: "var(--space-3)",
        right: "var(--space-3)",
        bottom: "calc(84px + env(safe-area-inset-bottom))",
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        pointerEvents: "none",
      }}
    >
      <div
        role="dialog"
        aria-label={t("title")}
        style={{
          pointerEvents: "auto",
          width: "100%",
          maxWidth: 420,
          display: "grid",
          gap: "var(--space-3)",
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderRadius: 16,
          boxShadow: "var(--shadow-pop, 0 8px 30px rgba(0,0,0,.16))",
          padding: "var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
          <span
            aria-hidden
            style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center" }}
          >
            <Icon name="locate" size={20} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.3 }}>{t("title")}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2, lineHeight: 1.4 }}>{t("body")}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button
            type="button"
            onClick={snooze}
            style={{ all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--muted)", padding: "8px 10px" }}
          >
            {t("dismiss")}
          </button>
          <Button variant="pri" size="sm" onClick={useMyLocation} disabled={locating}>
            {locating ? t("locating") : t("allow")}
          </Button>
        </div>
      </div>
    </div>
  );
}
