/**
 * PresenceAlertSettings — the user's opt-out for "nearby friend is free" push alerts, shown in
 * Settings beside BirthdaySettings. Reads/writes profiles.personal (owner-only user_private).
 *
 * Opt-OUT, not opt-in: the alerts are already friend-only, throttled, and gated on existing push
 * consent, so the default is on. Flip it off and the DB stops selecting you as an alert target
 * (claim_nearby_alert_targets honours presence_alerts_enabled). Saves immediately on toggle.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

export function PresenceAlertSettings() {
  const t = useTranslations("presenceAlertSettings");
  const trpc = useTrpc();
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.profiles.personal as unknown as { query: () => Promise<{ presenceAlertsEnabled: boolean }> };
    q.query()
      .then((p) => {
        if (cancelled) return;
        setEnabled(p.presenceAlertsEnabled);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  const toggle = useCallback(
    async (next: boolean) => {
      setEnabled(next); // optimistic
      setBusy(true);
      const mut = trpc.profiles.setPersonal as unknown as {
        mutate: (i: { presenceAlertsEnabled: boolean }) => Promise<unknown>;
      };
      try {
        await mut.mutate({ presenceAlertsEnabled: next });
      } catch {
        setEnabled(!next); // revert on failure
      } finally {
        setBusy(false);
      }
    },
    [trpc],
  );

  return (
    <section style={{ marginBottom: "var(--space-5)" }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 var(--space-2)", paddingLeft: 4 }}>
        {t("title")}
      </h2>
      <Card style={{ padding: "var(--space-4)" }}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: loaded && !busy ? "pointer" : "default" }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void toggle(e.target.checked)}
            disabled={!loaded || busy}
            style={{ marginTop: 3, width: 18, height: 18, accentColor: "var(--crimson)" }}
          />
          <span>
            <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{t("label")}</span>
            <span style={{ display: "block", fontSize: 12.5, color: "var(--muted)", marginTop: 2, lineHeight: 1.45 }}>{t("hint")}</span>
          </span>
        </label>
      </Card>
    </section>
  );
}
