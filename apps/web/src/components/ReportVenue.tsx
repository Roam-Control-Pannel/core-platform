/**
 * ReportVenue — a quiet "Report this venue" affordance at the foot of a venue page. The
 * user-facing half of the moderation backstop: with self-serve claiming, reporting is how a
 * wrongful claim or abusive content reaches the review queue (moderation_queue, via
 * moderation.reportVenue). Deliberately understated — a small link that expands to a short
 * form, not a prominent CTA.
 */
"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useTrpc, useSession } from "./TrpcProvider";

type ReportMutation = {
  mutate: (input: { venueId: string; detail?: string }) => Promise<{ ok: boolean }>;
};

export function ReportVenue({ venueId }: { venueId: string }) {
  const t = useTranslations("reportVenue");
  const trpc = useTrpc();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = detail.trim();
      await (trpc.moderation.reportVenue as unknown as ReportMutation).mutate(
        trimmed ? { venueId, detail: trimmed } : { venueId },
      );
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("submitFailed"));
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, detail]);

  if (done) {
    return (
      <p style={{ marginTop: "var(--space-8)", textAlign: "center", fontSize: 12.5, color: "var(--muted)" }}>
        {t("thanks")}
      </p>
    );
  }

  return (
    <div style={{ marginTop: "var(--space-8)", textAlign: "center" }}>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={{ all: "unset", cursor: "pointer", fontSize: 12.5, color: "var(--muted)", textDecoration: "underline" }}
        >
          {t("cta")}
        </button>
      ) : !session ? (
        <p style={{ fontSize: 12.5, color: "var(--muted)" }}>{t("signInToReport")}</p>
      ) : (
        <div style={{ maxWidth: 420, margin: "0 auto", textAlign: "left" }}>
          <label
            style={{
              display: "block",
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 6,
            }}
            htmlFor="report-detail"
          >
            {t("detailLabel")}
          </label>
          <textarea
            id="report-detail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={2000}
            placeholder={t("detailPlaceholder")}
            style={{
              width: "100%",
              boxSizing: "border-box",
              minHeight: 72,
              padding: "10px 12px",
              border: "1px solid var(--line)",
              borderRadius: 10,
              background: "#fff",
              color: "var(--ink)",
              fontFamily: "var(--ui)",
              fontSize: 16,
              resize: "vertical",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
            <button
              onClick={() => void submit()}
              disabled={busy}
              style={{
                all: "unset",
                cursor: busy ? "default" : "pointer",
                fontFamily: "var(--ui)",
                fontSize: 13,
                fontWeight: 600,
                color: "#fff",
                background: "var(--crimson)",
                padding: "8px 16px",
                borderRadius: 999,
              }}
            >
              {busy ? t("sending") : t("send")}
            </button>
            <button
              onClick={() => setOpen(false)}
              style={{ all: "unset", cursor: "pointer", fontSize: 13, color: "var(--muted)" }}
            >
              {t("cancel")}
            </button>
            {error ? <span role="alert" style={{ fontSize: 12.5, color: "var(--crimson-700)" }}>{error}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
