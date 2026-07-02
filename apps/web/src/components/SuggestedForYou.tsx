/**
 * SuggestedForYou — the dashboard's "Suggested for you" panel (Phase 4, v1 templates).
 *
 * Reads suggestions.list (ranked offer & post ideas tailored to the venue's prefs + engagement).
 * Renders nothing until the business has opted into suggestions. Every idea is REVIEW-FIRST: an
 * offer idea expands into a small editable form and publishes through offers.create; a post idea
 * gives editable copy you can copy into the Local posts composer. Nothing is ever auto-published.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Icon} from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { offerTypeLabel } from "../lib/offerTypes";

interface Suggestion {
  id: string;
  kind: "offer" | "post";
  offerType: string | null;
  title: string;
  body: string;
  suggestedDiscountPct: number | null;
  rationale: string;
}

export function SuggestedForYou({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [state, setState] = useState<{ enabled: boolean; suggestions: Suggestion[] } | undefined>(undefined);

  const load = useCallback(async () => {
    const q = trpc.suggestions.list as unknown as { query: (i: { venueId: string }) => Promise<{ enabled: boolean; suggestions: Suggestion[] }> };
    return q.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load().then((s) => { if (!cancelled) setState(s); }).catch(() => { if (!cancelled) setState({ enabled: false, suggestions: [] }); });
    return () => { cancelled = true; };
  }, [load]);

  // Hidden entirely until the business opts in (the Marketing section drives that).
  if (!state || !state.enabled || state.suggestions.length === 0) return null;

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}><Icon name="idea" size={16} /></span>
        <div style={{ minWidth: 0 }}>
          <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>Suggested for you</h2>
          <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>
            Tailored offer and post ideas — review and edit each one before it goes out.
          </p>
        </div>
      </header>

      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        {state.suggestions.map((s) =>
          s.kind === "offer" ? (
            <OfferSuggestion key={s.id} venueId={venueId} s={s} />
          ) : (
            <PostSuggestion key={s.id} s={s} />
          ),
        )}
      </div>
    </Card>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-lg)",
  padding: "var(--space-3) var(--space-4)",
  background: "var(--paper-2)",
};
const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 12px",
  marginTop: 8,
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 15,
  color: "var(--ink)",
};

function Rationale({ text }: { text: string }) {
  return <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>{text}</p>;
}

function OfferSuggestion({ venueId, s }: { venueId: string; s: Suggestion }) {
  const trpc = useTrpc();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [details, setDetails] = useState(s.body);
  const [pct, setPct] = useState(s.suggestedDiscountPct != null ? String(s.suggestedDiscountPct) : "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const usesPct = s.offerType === "percent_off";

  const publish = useCallback(async () => {
    setBusy(true);
    const create = trpc.offers.create as unknown as {
      mutate: (i: { venueId: string; title: string; details: string | null; offerType: string | null; discountPct: number | null }) => Promise<{ id: string }>;
    };
    try {
      const discount = usesPct && pct.trim() ? Math.min(100, Math.max(0, Number(pct))) : null;
      await create.mutate({ venueId, title: title.trim(), details: details.trim() || null, offerType: s.offerType, discountPct: Number.isFinite(discount as number) ? discount : null });
      setDone(true);
      setOpen(false);
    } catch {
      /* leave open to retry */
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, title, details, pct, usesPct, s.offerType]);

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 14.5, color: "var(--ink)" }}>{s.title}</span>
        {s.offerType ? (
          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", borderRadius: 999, padding: "1px 8px" }}>
            {offerTypeLabel(s.offerType)}
          </span>
        ) : null}
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{s.body}</p>
      <Rationale text={s.rationale} />

      {done ? (
        <p style={{ margin: "var(--space-2) 0 0", fontSize: 13, color: "var(--crimson-700)", fontWeight: 600 }}>Published — find it in Offers above to tweak or add a code.</p>
      ) : open ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Offer title" maxLength={120} style={fieldStyle} />
          {usesPct ? <input type="number" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Discount percent" placeholder="Discount %" style={fieldStyle} /> : null}
          <textarea value={details} onChange={(e) => setDetails(e.target.value)} aria-label="Offer details" rows={2} maxLength={1000} style={{ ...fieldStyle, resize: "vertical", minHeight: 56 }} />
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 8 }}>
            <Button variant="pri" size="sm" onClick={() => void publish()} disabled={busy || !title.trim()}>{busy ? "Publishing…" : "Publish offer"}</Button>
            <Button variant="neutral" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: "var(--space-2)" }}>
          <Button variant="neutral" size="sm" onClick={() => setOpen(true)}>Use this offer</Button>
        </div>
      )}
    </div>
  );
}

function PostSuggestion({ s }: { s: Suggestion }) {
  const [text, setText] = useState(s.body);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — the text is already selectable in the field */
    }
  }, [text]);

  return (
    <div style={cardStyle}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 14.5, color: "var(--ink)" }}>{s.title}</div>
      <Rationale text={s.rationale} />
      <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Post copy" rows={2} maxLength={1000} style={{ ...fieldStyle, resize: "vertical", minHeight: 56 }} />
      <div style={{ marginTop: 8 }}>
        <Button variant="neutral" size="sm" onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy — paste into Local posts"}</Button>
      </div>
    </div>
  );
}
