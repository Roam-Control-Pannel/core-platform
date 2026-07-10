/**
 * VenueOffers — the business dashboard's Offers manager. Publish an exclusive deal (title, the
 * detail, an optional redemption code, an end date and an optional total-redemptions cap), and
 * manage your live ones with each offer's running redemption count. Offers surface on the venue's
 * public "Offers" tab and to followers; users save them and redeem in-venue.
 *
 * offers.create / offers.mine / offers.remove. Owner-gated by RLS; this is presentation only.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, Button, Icon} from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { OFFER_TYPES, useOfferTypeLabel, offerTypeUsesPercent } from "../lib/offerTypes";
import { getFormatLocale } from "../lib/i18n/runtime";

interface OwnerOffer {
  id: string;
  title: string;
  details: string | null;
  code: string | null;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  offerType: string | null;
  discountPct: number | null;
  saves: number;
  redemptions: number;
}

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginBottom: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16,
  color: "var(--ink)",
  outline: "none",
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(getFormatLocale(), { day: "numeric", month: "short" });
}

export function VenueOffers({ venueId }: { venueId: string }) {
  const t = useTranslations("venueOffers");
  const offerTypeLabel = useOfferTypeLabel();
  const trpc = useTrpc();
  const [offers, setOffers] = useState<OwnerOffer[] | undefined>(undefined);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    const mine = trpc.offers.mine as unknown as { query: (i: { venueId: string }) => Promise<OwnerOffer[]> };
    return mine.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load().then((o) => { if (!cancelled) setOffers(Array.isArray(o) ? o : []); }).catch(() => { if (!cancelled) setOffers([]); });
    return () => { cancelled = true; };
  }, [load]);

  const reload = useCallback(() => {
    void load().then((o) => setOffers(Array.isArray(o) ? o : [])).catch(() => {});
  }, [load]);

  const remove = useCallback(async (offerId: string) => {
    const mut = trpc.offers.remove as unknown as { mutate: (i: { offerId: string }) => Promise<unknown> };
    setOffers((prev) => (prev ? prev.filter((o) => o.id !== offerId) : prev));
    try { await mut.mutate({ offerId }); } catch { reload(); }
  }, [trpc, reload]);

  return (
    <div>
      {composing ? (
        <OfferComposer venueId={venueId} onPosted={() => { setComposing(false); reload(); }} onCancel={() => setComposing(false)} />
      ) : (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="pri" onClick={() => setComposing(true)}><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="plus" size={14} /> {t("newOffer")}</span></Button>
        </div>
      )}

      {offers === undefined ? (
        <div style={{ height: 64, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : offers.length === 0 ? (
        <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5 }}>
          {t("empty")}
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {offers.map((o) => (
            <Card key={o.id} style={{ padding: "var(--space-3) var(--space-4)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15 }}>{o.title}</div>
                    {o.offerType ? (
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 9.5,
                          letterSpacing: ".04em",
                          textTransform: "uppercase",
                          color: "var(--crimson-700)",
                          background: "var(--crimson-tint)",
                          border: "1px solid var(--crimson-tint-2)",
                          borderRadius: 999,
                          padding: "1px 8px",
                        }}
                      >
                        {offerTypeLabel(o.offerType)}
                        {offerTypeUsesPercent(o.offerType) && o.discountPct != null ? ` · ${o.discountPct}%` : ""}
                      </span>
                    ) : null}
                  </div>
                  {o.details ? <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{o.details}</p> : null}
                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap", fontSize: 12, color: "var(--muted)" }}>
                    {o.code ? <span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: "var(--crimson-700)" }}>{o.code}</span> : null}
                    {o.endsAt ? <span>{t("ends", { date: shortDate(o.endsAt) })}</span> : null}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--ink-2)", fontWeight: 600 }}><Icon name="heart" size={12} /> {t("savedCount", { count: o.saves })}</span>
                    <span style={{ color: "var(--ink-2)", fontWeight: 600 }}>
                      <Icon name="redeem" size={12} /> {o.maxRedemptions != null ? t("redeemedOfMax", { count: o.redemptions, max: o.maxRedemptions }) : t("redeemedCount", { count: o.redemptions })}
                    </span>
                  </div>
                </div>
                <button type="button" onClick={() => void remove(o.id)} title={t("deleteOffer")} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 12, textDecoration: "underline", flexShrink: 0 }}>
                  {t("delete")}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function OfferComposer({ venueId, onPosted, onCancel }: { venueId: string; onPosted: () => void; onCancel: () => void }) {
  const t = useTranslations("venueOffers");
  const offerTypeLabelFor = useOfferTypeLabel();
  const trpc = useTrpc();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [code, setCode] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [offerType, setOfferType] = useState<string>("percent_off");
  const [discountPct, setDiscountPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const create = trpc.offers.create as unknown as {
      mutate: (i: { venueId: string; title: string; details: string | null; code: string | null; endsAt: string | null; maxRedemptions: number | null; offerType: string | null; discountPct: number | null }) => Promise<{ id: string }>;
    };
    try {
      const max = maxRedemptions.trim() ? Math.max(1, Math.floor(Number(maxRedemptions))) : null;
      // End of the chosen day, in the user's locale, as ISO.
      const endsAt = endsOn ? new Date(`${endsOn}T23:59:59`).toISOString() : null;
      const pct = offerTypeUsesPercent(offerType) && discountPct.trim()
        ? Math.min(100, Math.max(0, Number(discountPct)))
        : null;
      await create.mutate({
        venueId,
        title: title.trim(),
        details: details.trim() || null,
        code: code.trim() || null,
        endsAt,
        maxRedemptions: max != null && Number.isFinite(max) ? max : null,
        offerType,
        discountPct: pct != null && Number.isFinite(pct) ? pct : null,
      });
      onPosted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("composer.publishFailed"));
      setBusy(false);
    }
  }, [trpc, venueId, title, details, code, endsOn, maxRedemptions, offerType, discountPct, onPosted]);

  const canPost = title.trim().length > 0 && !busy;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>{t("newOffer")}</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("composer.titlePlaceholder")} aria-label={t("composer.titleAria")} maxLength={120} style={field} />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 150 }}>
          <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{t("composer.typeLabel")}</span>
          <select value={offerType} onChange={(e) => setOfferType(e.target.value)} aria-label={t("composer.typeAria")} style={field}>
            {OFFER_TYPES.map((ot) => (
              <option key={ot} value={ot}>{offerTypeLabelFor(ot)}</option>
            ))}
          </select>
        </label>
        {offerTypeUsesPercent(offerType) ? (
          <label style={{ flex: 1, minWidth: 150 }}>
            <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{t("composer.discountLabel")}</span>
            <input type="number" min={0} max={100} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} placeholder={t("composer.discountPlaceholder")} aria-label={t("composer.discountAria")} style={field} />
          </label>
        ) : null}
      </div>
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder={t("composer.detailsPlaceholder")} aria-label={t("composer.detailsAria")} rows={3} maxLength={1000} style={{ ...field, resize: "vertical", minHeight: 72 }} />
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("composer.codePlaceholder")} aria-label={t("composer.codeAria")} maxLength={40} autoCapitalize="characters" style={field} />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 150 }}>
          <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{t("composer.endsLabel")}</span>
          <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} aria-label={t("composer.endsAria")} style={field} />
        </label>
        <label style={{ flex: 1, minWidth: 150 }}>
          <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{t("composer.maxLabel")}</span>
          <input type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} placeholder={t("composer.maxPlaceholder")} aria-label={t("composer.maxAria")} style={field} />
        </label>
      </div>
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void submit()} disabled={!canPost}>{busy ? t("composer.publishing") : t("composer.publish")}</Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>{t("composer.cancel")}</Button>
      </div>
    </Card>
  );
}
