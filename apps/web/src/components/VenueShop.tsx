/**
 * VenueShop — the PUBLIC venue page's Shop tab: the live catalogue as a browsable grid, with real
 * buying (marketplace PR 3). On the Food to Go storefront this is a basket experience: add several
 * items, choose Collect or Deliver, and check out through market.checkoutCart → Stripe. Elsewhere
 * (the Roam shop) and for vouchers it stays a single-item buy → market.checkout, unchanged.
 *
 * Delivery: when the venue offers it, the Deliver toggle appears; the buyer enters an address and we
 * ask f2g.quoteDelivery (server-side geocode + the same deliverable-area + minimum-order rules the
 * checkout enforces) before payment, so the fee and "can we deliver here?" are known up front.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Pill, Icon, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { useChannel } from "./ChannelProvider";
import { formatPence } from "../lib/money";

interface ShopItem {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  pricePence: number;
  currency: string;
  stock: number | null;
  photoUrl: string | null;
}

interface CollectionSettings {
  orderAhead: boolean;
  paused: boolean;
  prepTimeMins: number;
  collectionInstructions: string | null;
}

interface DeliveryInfo {
  deliveryEnabled: boolean;
  paused: boolean;
  deliveryFeePence: number;
  minOrderPence: number;
  etaMins: number;
}

type Fulfilment = "collection" | "delivery";

export function VenueShop({ venueId }: { venueId: string }) {
  const t = useTranslations("venueShop");
  const trpc = useTrpc();
  const session = useSession();
  const { isF2G } = useChannel();
  const [items, setItems] = useState<ShopItem[] | undefined>(undefined);
  const [sellable, setSellable] = useState(false);
  const [paused, setPaused] = useState(false);
  const [collection, setCollection] = useState<CollectionSettings | null>(null);
  const [delivery, setDelivery] = useState<DeliveryInfo | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [cart, setCart] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const list = trpc.market.listByVenue as unknown as {
      query: (i: { venueId: string }) => Promise<{ sellable: boolean; paused: boolean; products: ShopItem[] }>;
    };
    list
      .query({ venueId })
      .then((r) => {
        if (cancelled) return;
        setItems(Array.isArray(r?.products) ? r.products : []);
        setSellable(!!r?.sellable);
        setPaused(!!r?.paused);
      })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  // On the Food to Go storefront, surface the venue's collection + delivery settings.
  useEffect(() => {
    if (!isF2G) return;
    let cancelled = false;
    trpc.f2g.collectionSettings
      .query({ venueId })
      .then((c) => { if (!cancelled) setCollection(c as CollectionSettings); })
      .catch(() => { /* the banner just won't render */ });
    trpc.f2g.deliverySettings
      .query({ venueId })
      .then((d) => { if (!cancelled) setDelivery(d as DeliveryInfo); })
      .catch(() => { /* delivery option just won't offer */ });
    return () => { cancelled = true; };
  }, [trpc, venueId, isF2G]);

  const buyable = sellable && !paused;
  const deliveryAvailable = !!delivery && delivery.deliveryEnabled && !delivery.paused;
  const productById = useMemo(() => new Map((items ?? []).map((p) => [p.id, p])), [items]);
  const cartLines = useMemo(
    () => Object.entries(cart).map(([id, n]) => ({ product: productById.get(id), quantity: n })).filter((l) => l.product && l.quantity > 0),
    [cart, productById],
  );

  const addToCart = useCallback((id: string, delta: number) => {
    setCart((c) => {
      const next = { ...c };
      const p = productById.get(id);
      const max = p?.stock != null ? p.stock : 20;
      const v = Math.max(0, Math.min(max, (c[id] ?? 0) + delta));
      if (v === 0) delete next[id];
      else next[id] = v;
      return next;
    });
  }, [productById]);

  const buy = useCallback(async (productId: string, quantity: number) => {
    setBuying(productId);
    setError(null);
    try {
      const checkout = trpc.market.checkout as unknown as {
        mutate: (i: { productId: string; quantity: number }) => Promise<{ url: string }>;
      };
      const { url } = await checkout.mutate({ productId, quantity });
      window.location.href = url; // Stripe-hosted payment page
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("checkoutFailed"));
      setBuying(null);
    }
  }, [trpc, t]);

  if (items === undefined) {
    return <div style={{ height: 140, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />;
  }
  if (items.length === 0) {
    return <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>{t("empty")}</p>;
  }

  return (
    <div>
      {isF2G && collection ? <CollectionBanner settings={collection} /> : null}
      {error ? <p role="alert" style={{ margin: "0 0 var(--space-3)", color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--space-3)" }}>
        {items.map((p) => {
          const soldOut = p.stock === 0;
          // On the f2g storefront, physical products go through the basket; vouchers stay single-buy.
          const carted = isF2G && p.kind === "product";
          const inCart = cart[p.id] ?? 0;
          return (
            <Card key={p.id} style={{ overflow: "hidden" }}>
              {p.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                <img src={p.photoUrl} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 120, objectFit: "cover" }} />
              ) : (
                <div aria-hidden style={{ height: 120, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
                  <Icon name={p.kind === "service" ? "ticket" : "bag"} size={28} />
                </div>
              )}
              <div style={{ padding: "var(--space-3)", display: "grid", gap: 6 }}>
                <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 14.5, lineHeight: 1.3 }}>{p.title}</div>
                {p.description ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {p.description}
                  </p>
                ) : null}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                  <strong style={{ fontFamily: "var(--display)", fontSize: 16, color: "var(--ink-hi)" }}>{formatPence(p.pricePence, p.currency)}</strong>
                  <Pill variant="neutral" size="sm">{p.kind === "service" ? t("kind.voucher") : soldOut ? t("kind.soldOut") : t("kind.collect")}</Pill>
                </div>
                {buyable && !soldOut ? (
                  !session ? (
                    <Link href="/account" style={{ textDecoration: "none" }}>
                      <Button variant="neutral" size="sm">{t("signInToBuy")}</Button>
                    </Link>
                  ) : carted ? (
                    inCart > 0 ? (
                      <Stepper
                        value={inCart}
                        onDec={() => addToCart(p.id, -1)}
                        onInc={() => addToCart(p.id, 1)}
                        decLabel={t("basket.decrease")}
                        incLabel={t("basket.increase")}
                      />
                    ) : (
                      <Button variant="pri" size="sm" onClick={() => addToCart(p.id, 1)}>{t("basket.add")}</Button>
                    )
                  ) : (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {p.kind === "product" ? (
                        <select
                          value={qty[p.id] ?? 1}
                          onChange={(e) => setQty((m) => ({ ...m, [p.id]: Number(e.target.value) }))}
                          aria-label={t("quantityAria")}
                          style={{ padding: "7px 8px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper-2)", fontFamily: "var(--ui)", fontSize: 13, color: "var(--ink)" }}
                        >
                          {Array.from({ length: Math.min(10, p.stock ?? 10) }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      ) : null}
                      <Button variant="pri" size="sm" onClick={() => void buy(p.id, qty[p.id] ?? 1)} disabled={buying !== null}>
                        {buying === p.id ? t("openingCheckout") : t("buy")}
                      </Button>
                    </div>
                  )
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      {isF2G && cartLines.length > 0 ? (
        <Basket
          venueId={venueId}
          lines={cartLines as { product: ShopItem; quantity: number }[]}
          onQty={addToCart}
          delivery={deliveryAvailable ? delivery : null}
          collection={collection}
        />
      ) : null}

      {paused ? (
        <p style={{ margin: "var(--space-4) 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>{t("collection.pausedNote")}</p>
      ) : !sellable ? (
        <p style={{ margin: "var(--space-4) 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>{t("payoutPending")}</p>
      ) : (
        <p style={{ margin: "var(--space-4) 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
          {t.rich("paymentsNote", { link: (chunks) => <Link href="/orders" style={{ color: "var(--crimson-700)" }}>{chunks}</Link> })}
        </p>
      )}
    </div>
  );
}

/* ── Basket (Food to Go): fulfilment choice + delivery address + checkout ─────────────────── */

interface DeliveryQuote {
  deliverable: boolean;
  reason: string;
  feePence: number;
  minOrderPence: number;
  etaMins: number;
  deliveryEnabled: boolean;
}

function Basket({
  venueId,
  lines,
  onQty,
  delivery,
  collection,
}: {
  venueId: string;
  lines: { product: ShopItem; quantity: number }[];
  onQty: (id: string, delta: number) => void;
  delivery: DeliveryInfo | null;
  collection: CollectionSettings | null;
}) {
  const t = useTranslations("venueShop");
  const trpc = useTrpc();
  const [fulfilment, setFulfilment] = useState<Fulfilment>("collection");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [notes, setNotes] = useState("");
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currency = lines[0]?.product.currency ?? "gbp";
  const subtotal = lines.reduce((s, l) => s + l.product.pricePence * l.quantity, 0);
  const isDelivery = fulfilment === "delivery";
  // Any address edit invalidates a prior quote — the buyer must re-check.
  const resetQuote = () => setQuote(null);

  const checkDelivery = useCallback(async () => {
    if (!line1.trim() || !postcode.trim()) {
      setError(t("delivery.enterAddress"));
      return;
    }
    setQuoting(true);
    setError(null);
    try {
      const q = trpc.f2g.quoteDelivery as unknown as {
        query: (i: { venueId: string; line1: string; postcode: string; subtotalPence: number }) => Promise<DeliveryQuote>;
      };
      const res = await q.query({ venueId, line1: line1.trim(), postcode: postcode.trim(), subtotalPence: subtotal });
      setQuote(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("delivery.checkFailed"));
    } finally {
      setQuoting(false);
    }
  }, [trpc, venueId, line1, postcode, subtotal, t]);

  const feePence = isDelivery && quote?.deliverable ? quote.feePence : 0;
  const total = subtotal + feePence;
  // Checkout is blocked for delivery until we have a positive quote for the entered address.
  const canCheckout = !isDelivery || (!!quote && quote.deliverable);

  const placeOrder = useCallback(async () => {
    setPlacing(true);
    setError(null);
    try {
      const checkout = trpc.market.checkoutCart as unknown as {
        mutate: (i: {
          venueId: string;
          items: { productId: string; quantity: number }[];
          fulfilment: Fulfilment;
          address?: { line1: string; line2?: string | null; locality?: string | null; postcode: string; notes?: string | null } | null;
        }) => Promise<{ url: string }>;
      };
      const { url } = await checkout.mutate({
        venueId,
        items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        fulfilment,
        address: isDelivery
          ? { line1: line1.trim(), line2: line2.trim() || null, locality: city.trim() || null, postcode: postcode.trim(), notes: notes.trim() || null }
          : null,
      });
      window.location.href = url;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("checkoutFailed"));
      setPlacing(false);
    }
  }, [trpc, venueId, lines, fulfilment, isDelivery, line1, line2, city, postcode, notes, t]);

  return (
    <div style={{ marginTop: "var(--space-4)", border: "1px solid var(--line)", borderRadius: 16, overflow: "hidden", background: "var(--card)" }}>
      <div style={{ padding: "var(--space-3) var(--space-4)", borderBottom: "1px solid var(--line)", fontFamily: "var(--display)", fontWeight: 700, fontSize: 15 }}>
        {t("basket.title")}
      </div>

      {/* Lines */}
      <div style={{ padding: "var(--space-3) var(--space-4)", display: "grid", gap: 10 }}>
        {lines.map((l) => (
          <div key={l.product.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.product.title}</div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{formatPence(l.product.pricePence, currency)}</div>
            </div>
            <Stepper value={l.quantity} onDec={() => onQty(l.product.id, -1)} onInc={() => onQty(l.product.id, 1)} decLabel={t("basket.decrease")} incLabel={t("basket.increase")} />
            <div style={{ width: 68, textAlign: "right", fontWeight: 700, fontSize: 14 }}>{formatPence(l.product.pricePence * l.quantity, currency)}</div>
          </div>
        ))}
      </div>

      {/* Fulfilment choice */}
      <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <FulfilChip on={fulfilment === "collection"} onClick={() => setFulfilment("collection")} icon="bag" label={t("fulfilment.collect")} />
          {delivery ? (
            <FulfilChip on={fulfilment === "delivery"} onClick={() => setFulfilment("delivery")} icon="locate" label={t("fulfilment.deliver")} />
          ) : null}
        </div>
        {!isDelivery && collection ? (
          <p style={{ margin: "8px 2px 0", fontSize: 12.5, color: "var(--ink-2)" }}>{t("collection.readyIn", { mins: collection.prepTimeMins })}</p>
        ) : null}
      </div>

      {/* Delivery address */}
      {isDelivery ? (
        <div style={{ padding: "0 var(--space-4) var(--space-3)", display: "grid", gap: 8 }}>
          <input value={line1} placeholder={t("delivery.line1")} onChange={(e) => { setLine1(e.target.value); resetQuote(); }} style={field} />
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
            <input value={city} placeholder={t("delivery.city")} onChange={(e) => { setCity(e.target.value); resetQuote(); }} style={field} />
            <input value={postcode} placeholder={t("delivery.postcode")} onChange={(e) => { setPostcode(e.target.value.toUpperCase()); resetQuote(); }} style={field} />
          </div>
          <input value={line2} placeholder={t("delivery.line2")} onChange={(e) => { setLine2(e.target.value); resetQuote(); }} style={field} />
          <input value={notes} placeholder={t("delivery.notes")} maxLength={300} onChange={(e) => setNotes(e.target.value)} style={field} />
          <div>
            <Button variant="neutral" size="sm" onClick={() => void checkDelivery()} disabled={quoting}>
              {quoting ? t("delivery.checking") : t("delivery.check")}
            </Button>
          </div>
          {quote ? (
            <p style={{ margin: "2px 0 0", fontSize: 13, lineHeight: 1.45, color: quote.deliverable ? "var(--success)" : "var(--crimson-700)" }}>
              {quote.deliverable
                ? t("delivery.deliverable", { eta: quote.etaMins })
                : quote.reason === "below_minimum"
                  ? t("delivery.minNotMet", { min: formatPence(quote.minOrderPence, currency) })
                  : t("delivery.notDeliverable")}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <p role="alert" style={{ margin: "0 var(--space-4) var(--space-3)", fontSize: 13, color: "var(--crimson-700)" }}>{error}</p> : null}

      {/* Totals + checkout */}
      <div style={{ padding: "var(--space-3) var(--space-4)", borderTop: "1px solid var(--line)", background: "var(--paper-2)", display: "grid", gap: 6 }}>
        <TotalRow label={t("basket.subtotal")} value={formatPence(subtotal, currency)} />
        {isDelivery && quote?.deliverable ? (
          <TotalRow label={t("delivery.fee")} value={feePence > 0 ? formatPence(feePence, currency) : t("delivery.free")} />
        ) : null}
        <TotalRow label={t("basket.total")} value={formatPence(total, currency)} strong />
        <div style={{ marginTop: 4 }}>
          <Button variant="pri" onClick={() => void placeOrder()} disabled={placing || !canCheckout}>
            {placing ? t("basket.opening") : t("basket.checkout")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ value, onDec, onInc, decLabel, incLabel }: { value: number; onDec: () => void; onInc: () => void; decLabel: string; incLabel: string }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--line)", borderRadius: 10, background: "var(--paper-2)" }}>
      <button type="button" aria-label={decLabel} onClick={onDec} style={stepBtn}>−</button>
      <span style={{ minWidth: 22, textAlign: "center", fontSize: 14, fontWeight: 700 }}>{value}</span>
      <button type="button" aria-label={incLabel} onClick={onInc} style={stepBtn}>+</button>
    </div>
  );
}

function FulfilChip({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: "bag" | "locate"; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderRadius: 999,
        cursor: "pointer",
        border: `1px solid ${on ? "var(--crimson)" : "var(--line)"}`,
        background: on ? "var(--crimson)" : "var(--card)",
        color: on ? "#fff" : "var(--ink)",
        fontSize: 13.5,
        fontWeight: 600,
      }}
    >
      <Icon name={icon} size={15} /> {label}
    </button>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: strong ? 15 : 13.5, fontWeight: strong ? 800 : 500, color: strong ? "var(--ink-hi)" : "var(--ink-2)" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const stepBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  width: 28,
  height: 28,
  display: "grid",
  placeItems: "center",
  fontSize: 16,
  fontWeight: 700,
  color: "var(--ink)",
};

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "var(--ui)",
  color: "var(--ink)",
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  outline: "none",
};

/**
 * CollectionBanner — the Food to Go order-ahead & collect summary shown above the menu. Uses the
 * neutral/success tokens (not the partially-overridden brand ramp) so it reads cleanly under the
 * f2g palette. Paused reads as a clear amber notice; otherwise the prep-time expectation is set.
 */
function CollectionBanner({ settings }: { settings: CollectionSettings }) {
  const t = useTranslations("venueShop");
  const paused = settings.paused;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "12px 14px",
        borderRadius: 14,
        marginBottom: "var(--space-3)",
        background: paused ? "var(--paper-2)" : "var(--success-tint)",
        border: `1px solid ${paused ? "var(--line)" : "transparent"}`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 34,
          height: 34,
          borderRadius: 10,
          flexShrink: 0,
          background: paused ? "var(--line)" : "#fff",
          color: paused ? "var(--muted)" : "var(--success)",
        }}
      >
        <Icon name={paused ? "ban" : "bag"} size={17} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: paused ? "var(--ink-2)" : "var(--success)" }}>
          {paused ? t("collection.paused") : t("collection.orderAhead")}
        </div>
        <div style={{ marginTop: 1, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.4 }}>
          {paused
            ? t("collection.pausedNote")
            : settings.collectionInstructions
              ? `${t("collection.readyIn", { mins: settings.prepTimeMins })} · ${settings.collectionInstructions}`
              : t("collection.readyIn", { mins: settings.prepTimeMins })}
        </div>
      </div>
    </div>
  );
}
