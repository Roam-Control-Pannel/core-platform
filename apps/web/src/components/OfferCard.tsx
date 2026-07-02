/**
 * OfferCard — a consumer-facing offer with the save + redeem loop (used on a venue's Offers tab
 * and in the Home "deals" surfaces). Save toggles offers.save/unsave; Redeem calls offers.redeem
 * (the SECURITY DEFINER RPC), and on success reveals the code + marks "Redeemed ✓".
 *
 * Honor-system v1: the user taps Redeem at the counter, staff eyeball the revealed code + state.
 * The code stays hidden until redeemed. Signed-out users are nudged to sign in just-in-time.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

export interface ConsumerOffer {
  id: string;
  title: string;
  details: string | null;
  code: string | null;
  endsAt: string | null;
  saved: boolean;
  redeemed: boolean;
  venueName?: string | null;
  venueSlug?: string | null;
  venueId?: string | null;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function OfferCard({ offer, showVenue = false }: { offer: ConsumerOffer; showVenue?: boolean }) {
  const trpc = useTrpc();
  const session = useSession();
  const signedIn = !!session;

  const [saved, setSaved] = useState(offer.saved);
  const [redeemed, setRedeemed] = useState(offer.redeemed);
  const [code, setCode] = useState<string | null>(offer.redeemed ? offer.code : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toggleSave = async () => {
    if (!signedIn) { setNote("Sign in to save deals."); return; }
    const next = !saved;
    setSaved(next);
    const api = trpc.offers as unknown as { save: { mutate: (i: { offerId: string }) => Promise<unknown> }; unsave: { mutate: (i: { offerId: string }) => Promise<unknown> } };
    try { await (next ? api.save : api.unsave).mutate({ offerId: offer.id }); }
    catch { setSaved(!next); }
  };

  const redeem = async () => {
    if (!signedIn) { setNote("Sign in to redeem this offer."); return; }
    setBusy(true);
    setNote(null);
    const api = trpc.offers.redeem as unknown as {
      mutate: (i: { offerId: string }) => Promise<{ ok: boolean; reason?: string; code?: string | null }>;
    };
    try {
      const res = await api.mutate({ offerId: offer.id });
      if (res.ok) {
        setRedeemed(true);
        setCode(res.code ?? offer.code ?? null);
      } else {
        setNote(res.reason === "sold_out" ? "This offer has been fully redeemed." : "This offer has expired.");
      }
    } catch {
      setNote("Couldn't redeem just now — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const venueHref = offer.venueSlug || offer.venueId ? `/venue/${offer.venueSlug ?? offer.venueId}` : null;

  return (
    <div style={{ padding: "var(--space-3) var(--space-4)", borderRadius: "var(--r-lg)", background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)" }}>
      {showVenue && offer.venueName ? (
        venueHref ? (
          <Link href={venueHref} style={{ fontSize: 11.5, fontWeight: 700, color: "var(--crimson-700)", textDecoration: "none", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".04em" }}>{offer.venueName}</Link>
        ) : (
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--crimson-700)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".04em" }}>{offer.venueName}</div>
        )
      ) : null}
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>{offer.title}</div>
      {offer.details ? <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{offer.details}</p> : null}
      {offer.endsAt ? <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--muted)" }}>Ends {shortDate(offer.endsAt)}</div> : null}

      {/* Redeemed → reveal the code + state. Otherwise the action row. */}
      {redeemed ? (
        <div style={{ marginTop: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: "var(--success)" }}>Redeemed <Icon name="check" size={14} /></span>
          {code ? (
            <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--crimson-700)", background: "#fff", border: "1px dashed var(--crimson-tint-2)", borderRadius: "var(--r-sm)", padding: "3px 10px" }}>
              {code}
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Show this to staff.</span>
          )}
        </div>
      ) : (
        <div style={{ marginTop: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void redeem()}
            disabled={busy}
            style={{ all: "unset", cursor: busy ? "default" : "pointer", padding: "7px 16px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontWeight: 600, fontSize: 13.5 }}
          >
            {busy ? "Redeeming…" : "Redeem"}
          </button>
          <button
            type="button"
            onClick={() => void toggleSave()}
            aria-pressed={saved}
            style={{ all: "unset", cursor: "pointer", padding: "7px 14px", borderRadius: 999, background: "#fff", border: "1px solid var(--crimson-tint-2)", color: "var(--crimson-700)", fontWeight: 600, fontSize: 13.5 }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="heart" size={14} style={saved ? { fill: "currentColor" } : {}} />
              {saved ? "Saved" : "Save"}
            </span>
          </button>
        </div>
      )}
      {note ? <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-2)" }}>{note}</div> : null}
    </div>
  );
}
