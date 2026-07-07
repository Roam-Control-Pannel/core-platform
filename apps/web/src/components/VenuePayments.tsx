/**
 * VenuePayments — the business dashboard's payout-onboarding card (marketplace PR 1).
 *
 * Reads payments.accountStatus and renders one of four honest states:
 *   - not configured   : payments aren't switched on for this environment (quiet note).
 *   - not connected    : "Get paid on Roam" pitch + Set up payouts (Stripe-hosted onboarding —
 *                        Roam never sees ID documents or bank details).
 *   - in progress      : onboarding started but Stripe hasn't enabled charges/payouts yet;
 *                        the button resumes the same hosted flow.
 *   - active           : green chips; selling unlocks in the shop slice.
 *
 * Returning from Stripe lands on /dashboard/[venueId]?payments=return|refresh — on mount we
 * see that param, call refreshStatus to sync the flags, and strip the query so a reload
 * doesn't re-sync. The account.updated webhook keeps the flags fresh the rest of the time.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

interface PayoutStatus {
  configured: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export function VenuePayments({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [status, setStatus] = useState<PayoutStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const statusQ = trpc.payments.accountStatus as unknown as {
      query: (i: { venueId: string }) => Promise<PayoutStatus>;
    };
    const refresh = trpc.payments.refreshStatus as unknown as {
      mutate: (i: { venueId: string }) => Promise<PayoutStatus>;
    };

    // Back from Stripe onboarding? Sync from Stripe's live state, then clean the URL.
    const params = new URLSearchParams(window.location.search);
    const returning = params.get("payments");
    const load = returning
      ? refresh.mutate({ venueId }).catch(() => statusQ.query({ venueId }))
      : statusQ.query({ venueId });

    load
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (returning) {
          params.delete("payments");
          const qs = params.toString();
          window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus({ configured: false, connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  const startOnboarding = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const link = trpc.payments.createOnboardingLink as unknown as {
        mutate: (i: { venueId: string }) => Promise<{ url: string }>;
      };
      const { url } = await link.mutate({ venueId });
      window.location.href = url; // Stripe-hosted onboarding; returns to this dashboard.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't start payout setup.");
      setBusy(false);
    }
  }, [trpc, venueId]);

  if (status === undefined) {
    return <div style={{ height: 84, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />;
  }

  if (!status.configured) {
    return (
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        Selling on Roam is nearly here — payment processing isn&apos;t switched on for this
        environment yet.
      </p>
    );
  }

  const active = status.chargesEnabled && status.payoutsEnabled;

  return (
    <div>
      {active ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
            <StatusChip ok label="Payouts active" />
            <StatusChip ok label="Charges enabled" />
          </div>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            You&apos;re set up to get paid. Your shop — products, services and vouchers — arrives
            here next; everything you sell will pay out to the bank account you connected.
          </p>
        </>
      ) : status.connected ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
            <StatusChip ok={status.detailsSubmitted} label={status.detailsSubmitted ? "Details submitted" : "Details needed"} />
            <StatusChip ok={false} label="Payouts pending" />
          </div>
          <p style={{ margin: "0 0 var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {status.detailsSubmitted
              ? "Stripe is reviewing your details — payouts usually switch on within a day or two. Check back, or finish anything outstanding:"
              : "Your payout setup isn't finished yet. Pick up where you left off — it takes a few minutes:"}
          </p>
          <Button variant="pri" size="sm" onClick={() => void startOnboarding()} disabled={busy}>
            {busy ? "Opening Stripe…" : "Continue payout setup"}
          </Button>
        </>
      ) : (
        <>
          <p style={{ margin: "0 0 var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            Connect a payout account to sell products, services and vouchers on Roam. Setup is
            handled securely by Stripe — Roam never sees your ID or bank details.
          </p>
          <Button variant="pri" size="sm" onClick={() => void startOnboarding()} disabled={busy}>
            {busy ? "Opening Stripe…" : "Set up payouts"}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" style={{ margin: "var(--space-2) 0 0", fontSize: 12.5, color: "var(--crimson-700)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 10px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: ok ? "var(--success)" : "var(--muted)",
        background: ok ? "var(--success-tint)" : "var(--paper-2)",
      }}
    >
      <span aria-hidden style={{ fontSize: 7 }}>●</span> {label}
    </span>
  );
}
