/**
 * BirthdayOffer — the business's standing "birthday treat" config on the dashboard.
 *
 * Set a title + detail and switch it on; the platform delivers it automatically to followers whose
 * birthday is today AND who opted into birthday treats — the business never sees who or when a
 * birthday is, only the delivered COUNT. venueBirthday.getOffer / setOffer / stats (owner-gated).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

interface OfferConfig { enabled: boolean; title: string | null; details: string | null }
interface Stats { sentThisMonth: number; sentTotal: number }

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginTop: 6,
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 15,
  color: "var(--ink)",
};

export function BirthdayOffer({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [enabled, setEnabled] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const getOffer = trpc.venueBirthday.getOffer as unknown as { query: (i: { venueId: string }) => Promise<OfferConfig> };
    const getStats = trpc.venueBirthday.stats as unknown as { query: (i: { venueId: string }) => Promise<Stats> };
    Promise.all([getOffer.query({ venueId }), getStats.query({ venueId }).catch(() => null)])
      .then(([o, s]) => {
        if (cancelled) return;
        setEnabled(o.enabled);
        setTitle(o.title ?? "");
        setDetails(o.details ?? "");
        setStats(s);
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  const save = useCallback(async (nextEnabled: boolean) => {
    setBusy(true);
    setSaved(false);
    const mut = trpc.venueBirthday.setOffer as unknown as {
      mutate: (i: { venueId: string; enabled: boolean; title: string | null; details: string | null }) => Promise<unknown>;
    };
    try {
      await mut.mutate({ venueId, enabled: nextEnabled, title: title.trim() || null, details: details.trim() || null });
      setEnabled(nextEnabled);
      setSaved(true);
    } catch {
      /* keep form for retry */
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, title, details]);

  return (
    <div>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        Set a treat and we&apos;ll deliver it automatically to followers on their birthday — the ones
        who&apos;ve opted in. You never see whose birthday it is, only how many were sent.
      </p>

      {stats ? (
        <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <StatTile label="Sent this month" value={stats.sentThisMonth} />
          <StatTile label="Sent all time" value={stats.sentTotal} />
        </div>
      ) : null}

      <label style={{ display: "block", marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>The treat</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!loaded || busy} placeholder="e.g. A free birthday coffee" maxLength={120} aria-label="Birthday treat title" style={field} />
      </label>

      <label style={{ display: "block", marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>Details (optional)</span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} disabled={!loaded || busy} rows={2} maxLength={500} placeholder="Show this message in-venue on your birthday to claim." aria-label="Birthday treat details" style={{ ...field, resize: "vertical", minHeight: 56 }} />
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <Button variant="pri" onClick={() => void save(enabled)} disabled={!loaded || busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="neutral" onClick={() => void save(!enabled)} disabled={!loaded || busy || !title.trim()}>
          {enabled ? "Turn off" : "Turn on"}
        </Button>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: enabled ? "var(--crimson-700)" : "var(--muted)" }}>
          {enabled ? "● Live" : "Off"}
        </span>
        {saved ? <span style={{ fontSize: 13, color: "var(--crimson-700)", fontWeight: 600 }}>Saved ✓</span> : null}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ flex: 1, padding: "12px 14px", borderRadius: "var(--r-md)", border: "1px solid var(--line)", background: "var(--card)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 22, color: "var(--ink)", lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}
