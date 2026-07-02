/**
 * BirthdayTreats — the consumer's wallet of live birthday treats, shown on Home around their
 * birthday. Reads birthday.mine (the caller's own grants, self-RLS). Each treat can be redeemed in
 * one tap, which reveals its code to show in-venue. Self-hiding: renders nothing when there are no
 * live treats, so it only appears when it's relevant (birthday week).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

interface Treat {
  venueId: string;
  venueName: string | null;
  venueSlug: string | null;
  title: string | null;
  code: string | null;
  expiresAt: string | null;
  redeemed: boolean;
}

export function BirthdayTreats() {
  const trpc = useTrpc();
  const session = useSession();
  const [treats, setTreats] = useState<Treat[] | null>(null);

  const load = useCallback(async () => {
    const q = trpc.birthday.mine as unknown as { query: () => Promise<Treat[]> };
    return q.query();
  }, [trpc]);

  useEffect(() => {
    if (!session) { setTreats([]); return; }
    let cancelled = false;
    load().then((t) => { if (!cancelled) setTreats(Array.isArray(t) ? t : []); }).catch(() => { if (!cancelled) setTreats([]); });
    return () => { cancelled = true; };
  }, [session, load]);

  const onRedeemed = useCallback((venueId: string) => {
    setTreats((prev) => (prev ? prev.map((t) => (t.venueId === venueId ? { ...t, redeemed: true } : t)) : prev));
  }, []);

  if (!treats || treats.length === 0) return null;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)", borderColor: "var(--crimson-tint-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "var(--space-3)" }}>
        <span aria-hidden style={{ fontSize: 20 }}>🎂</span>
        <div className="t-h4" style={{ fontFamily: "var(--display)", fontWeight: 600, color: "var(--ink)" }}>
          Happy birthday! Treats for you
        </div>
      </div>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        {treats.map((t) => <TreatRow key={t.venueId} treat={t} onRedeemed={() => onRedeemed(t.venueId)} />)}
      </div>
    </Card>
  );
}

function TreatRow({ treat, onRedeemed }: { treat: Treat; onRedeemed: () => void }) {
  const trpc = useTrpc();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(treat.redeemed ? treat.code : null);
  const redeemed = treat.redeemed || code != null;

  const redeem = useCallback(async () => {
    setBusy(true);
    const mut = trpc.birthday.redeem as unknown as { mutate: (i: { venueId: string }) => Promise<{ ok: boolean; code: string | null }> };
    try {
      const res = await mut.mutate({ venueId: treat.venueId });
      if (res.ok) { setCode(res.code ?? treat.code); onRedeemed(); }
    } catch {
      /* leave as-is to retry */
    } finally {
      setBusy(false);
    }
  }, [trpc, treat.venueId, treat.code, onRedeemed]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "10px 12px", borderRadius: "var(--r-md)", border: "1px solid var(--line)", background: "var(--paper-2)" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>
          {treat.title?.trim() || "A birthday treat"}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 1 }}>
          {treat.venueName ?? "A place you follow"}
          {treat.expiresAt ? ` · until ${formatDate(treat.expiresAt)}` : ""}
        </div>
      </div>
      {redeemed ? (
        <span style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13, color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", borderRadius: 8, padding: "6px 10px", whiteSpace: "nowrap" }}>
          {code ?? "Redeemed"}
        </span>
      ) : (
        <Button variant="pri" size="sm" onClick={() => void redeem()} disabled={busy}>{busy ? "…" : "Redeem"}</Button>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
