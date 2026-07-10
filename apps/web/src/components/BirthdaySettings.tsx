/**
 * BirthdaySettings — the user's private birthday + birthday-offer opt-in, shown in Settings.
 *
 * Reads/writes profiles.personal (backed by the owner-only user_private table). This data is
 * PRIVATE: the copy makes clear that businesses never see the date — it's only used to send the
 * birthday treats the user has opted into, from places they already follow. Nothing here is shared
 * until they turn the toggle on, and even then only the platform (not a business) sees the date.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

export function BirthdaySettings() {
  const t = useTranslations("birthdaySettings");
  const trpc = useTrpc();
  const [birthDate, setBirthDate] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    const q = trpc.profiles.personal as unknown as { query: () => Promise<{ birthDate: string | null; birthdayOffersEnabled: boolean }> };
    q.query()
      .then((p) => {
        if (cancelled) return;
        setBirthDate(p.birthDate ?? "");
        setEnabled(p.birthdayOffersEnabled);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [trpc]);

  const save = useCallback(async () => {
    setBusy(true);
    setStatus("idle");
    const mut = trpc.profiles.setPersonal as unknown as {
      mutate: (i: { birthDate: string | null; birthdayOffersEnabled: boolean }) => Promise<unknown>;
    };
    try {
      await mut.mutate({ birthDate: birthDate || null, birthdayOffersEnabled: enabled });
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, [trpc, birthDate, enabled]);

  return (
    <section style={{ marginBottom: "var(--space-5)" }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", margin: "0 0 var(--space-2)", paddingLeft: 4 }}>
        {t("title")}
      </h2>
      <Card style={{ padding: "var(--space-4)" }}>
        <label style={{ display: "block", marginBottom: "var(--space-3)" }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>{t("yourBirthday")}</span>
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            disabled={!loaded || busy}
            aria-label={t("dobAria")}
            style={{ width: "100%", maxWidth: 220, boxSizing: "border-box", padding: "10px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)" }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: "var(--space-3)" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!loaded || busy} style={{ marginTop: 3, width: 18, height: 18, accentColor: "var(--crimson)" }} />
          <span style={{ fontSize: 13.5, color: "var(--ink)", lineHeight: 1.45 }}>
            {t("treatsOptIn")}
          </span>
        </label>

        <p style={{ margin: "0 0 var(--space-3)", fontSize: 12, color: "var(--muted)", lineHeight: 1.5, display: "flex", gap: 6 }}>
          <Icon name="lock" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {t("privacyNote")}
          </span>
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <Button variant="pri" size="sm" onClick={() => void save()} disabled={!loaded || busy}>
            {busy ? t("saving") : t("save")}
          </Button>
          {status === "saved" ? <span style={{ fontSize: 13, color: "var(--crimson-700)", fontWeight: 600 }}>{t("saved")}</span> : null}
          {status === "error" ? <span style={{ fontSize: 13, color: "var(--crimson-700)" }}>{t("saveFailed")}</span> : null}
        </div>
      </Card>
    </section>
  );
}
