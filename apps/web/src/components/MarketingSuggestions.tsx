/**
 * MarketingSuggestions — the claim-time onboarding + ongoing preferences for automated marketing.
 *
 * First run (the venue has never been onboarded): a friendly card that leads with "turn on
 * automated suggestions?" and captures a few answers — a discount CAP (0–50%), the offer THEMES the
 * business likes, and a note on what they discount. "Turn on" saves + opts in; "Not now" records
 * that they've seen it (so it stops prompting) without opting in. Afterwards the same card shows a
 * summary with an Edit toggle and an on/off switch — the "set it up later" entry point.
 *
 * These answers feed the suggestion engine (Phase 4). venueMarketing.get / set (owner-gated).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { OFFER_TYPES, OFFER_TYPE_LABELS, offerTypeLabel } from "../lib/offerTypes";

interface Prefs {
  suggestionsEnabled: boolean;
  discountCapPct: number | null;
  offerTypes: string[];
  productNotes: string | null;
  onboarded: boolean;
}

export function MarketingSuggestions({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [prefs, setPrefs] = useState<Prefs | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);

  // Form state (seeded from prefs once loaded).
  const [cap, setCap] = useState(20);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const q = trpc.venueMarketing.get as unknown as { query: (i: { venueId: string }) => Promise<Prefs> };
    return q.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((p) => {
        if (cancelled) return;
        setPrefs(p);
        setCap(p.discountCapPct ?? 20);
        setTypes(new Set(p.offerTypes));
        setNotes(p.productNotes ?? "");
        if (!p.onboarded) setEditing(true); // first run → straight into the questions
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [load]);

  const save = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      const mut = trpc.venueMarketing.set as unknown as {
        mutate: (i: { venueId: string; suggestionsEnabled: boolean; discountCapPct: number | null; offerTypes: string[]; productNotes: string | null; markOnboarded: boolean }) => Promise<unknown>;
      };
      const next: Prefs = {
        suggestionsEnabled: enabled,
        discountCapPct: cap,
        offerTypes: Array.from(types),
        productNotes: notes.trim() || null,
        onboarded: true,
      };
      try {
        await mut.mutate({ venueId, suggestionsEnabled: enabled, discountCapPct: cap, offerTypes: next.offerTypes, productNotes: next.productNotes, markOnboarded: true });
        setPrefs(next);
        setEditing(false);
      } catch {
        /* keep the form open so they can retry */
      } finally {
        setBusy(false);
      }
    },
    [trpc, venueId, cap, types, notes],
  );

  const toggleType = (t: string) =>
    setTypes((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t); else n.add(t);
      return n;
    });

  if (failed) return <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Couldn&apos;t load your preferences just now.</p>;
  if (prefs === undefined) return <div style={{ height: 80, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />;

  // ── Summary view (onboarded, not editing) ─────────────────────────────────────────────────
  if (prefs.onboarded && !editing) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "var(--space-2)" }}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              padding: "2px 10px",
              borderRadius: 999,
              color: prefs.suggestionsEnabled ? "var(--crimson-700)" : "var(--muted)",
              background: prefs.suggestionsEnabled ? "var(--crimson-tint)" : "var(--paper-2)",
              border: `1px solid ${prefs.suggestionsEnabled ? "var(--crimson-tint-2)" : "var(--line)"}`,
            }}
          >
            {prefs.suggestionsEnabled ? "Suggestions on" : "Suggestions off"}
          </span>
        </div>
        <p style={{ margin: "0 0 var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {prefs.suggestionsEnabled
            ? "We'll suggest offers and posts tailored to you — never auto-published, always yours to edit first."
            : "Automated suggestions are off. Turn them on to get tailored offer and post ideas."}
          {prefs.discountCapPct != null ? ` Discount cap ${prefs.discountCapPct}%.` : ""}
        </p>
        {prefs.offerTypes.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
            {prefs.offerTypes.map((t) => (
              <span key={t} style={chip(false)}>{offerTypeLabel(t)}</span>
            ))}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="neutral" size="sm" onClick={() => setEditing(true)}>Edit preferences</Button>
          <Button variant="neutral" size="sm" onClick={() => void save(!prefs.suggestionsEnabled)} disabled={busy}>
            {prefs.suggestionsEnabled ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </div>
    );
  }

  // ── Wizard / edit form ────────────────────────────────────────────────────────────────────
  const firstRun = !prefs.onboarded;
  return (
    <div>
      {firstRun ? (
        <p style={{ margin: "0 0 var(--space-4)", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Want a hand marketing your business? Turn on automated suggestions and we&apos;ll propose
          offers and posts tailored to you — always yours to review and edit before anything goes out.
          Answer a few quick questions to make them relevant.
        </p>
      ) : null}

      <label style={{ display: "block", marginBottom: "var(--space-4)" }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
          Maximum discount you&apos;re happy to offer: <span style={{ color: "var(--crimson-700)" }}>{cap}%</span>
        </span>
        <input type="range" min={0} max={50} step={5} value={cap} onChange={(e) => setCap(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--crimson)" }} aria-label="Discount cap percent" />
      </label>

      <div style={{ marginBottom: "var(--space-4)" }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>
          Which kinds of deal would you run? (pick any)
        </span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {OFFER_TYPES.filter((t) => t !== "other").map((t) => (
            <button key={t} type="button" onClick={() => toggleType(t)} style={chip(types.has(t))}>
              {OFFER_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <label style={{ display: "block", marginBottom: "var(--space-4)" }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
          What products or services do you usually discount?
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. weekday lunch mains, first coffee for new customers, quiet-afternoon haircuts…"
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)", resize: "vertical", minHeight: 72 }}
        />
      </label>

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Button variant="pri" onClick={() => void save(true)} disabled={busy}>
          {busy ? "Saving…" : firstRun ? "Turn on suggestions" : "Save preferences"}
        </Button>
        {firstRun ? (
          <Button variant="neutral" onClick={() => void save(false)} disabled={busy}>Not now</Button>
        ) : (
          <Button variant="neutral" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
        )}
      </div>
    </div>
  );
}

function chip(active: boolean): React.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    boxSizing: "border-box",
    padding: "7px 13px",
    minHeight: 38,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    fontFamily: "var(--ui)",
    fontSize: 13,
    fontWeight: 600,
    color: active ? "var(--crimson-700)" : "var(--ink-2)",
    background: active ? "var(--crimson-tint)" : "var(--card)",
    border: `1px solid ${active ? "var(--crimson-tint-2)" : "var(--line)"}`,
  };
}
