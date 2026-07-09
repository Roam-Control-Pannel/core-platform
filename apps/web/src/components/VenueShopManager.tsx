/**
 * VenueShopManager — the business dashboard's Shop tab (marketplace PR 2): the catalogue
 * manager for everything a venue sells. Two kinds in one list — physical products (click &
 * collect, optional stock) and services/vouchers (digital fulfilment, usually no stock).
 *
 * Composer: kind toggle, title, description, price (typed in pounds, stored in pence —
 * see lib/money), optional stock, one photo (uploaded straight to the PUBLIC venue-media
 * bucket under the venue-id path prefix, exactly like OwnerMediaManager — storage RLS is
 * the boundary). Rows: photo thumb, title, kind + price + stock line, Live/Hidden pill,
 * edit (prefills the composer), show/hide, delete.
 *
 * Buying goes live in the checkout slice; until then the public Shop tab shows the
 * catalogue with an honest "buying opens soon" note, so stocking the shop now is useful.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Pill, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { getSupabaseBrowser } from "../lib/supabase";
import { formatPence, parsePriceToPence } from "../lib/money";
import { prepareImage } from "../lib/prepareImage";

export interface ShopProduct {
  id: string;
  venueId: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  pricePence: number;
  currency: string;
  stock: number | null;
  photoUrl: string | null;
  active: boolean;
  createdAt: string;
}

const VENUE_MEDIA_BUCKET = "venue-media";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_BYTES = 10 * 1024 * 1024;

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16,
  color: "var(--ink)",
  outline: "none",
};

export function VenueShopManager({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [products, setProducts] = useState<ShopProduct[] | undefined>(undefined);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<ShopProduct | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const mine = trpc.market.mine as unknown as { query: (i: { venueId: string }) => Promise<ShopProduct[]> };
    return mine.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((r) => { if (!cancelled) setProducts(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setProducts([]); });
    return () => { cancelled = true; };
  }, [load]);

  const refresh = useCallback(async () => {
    try {
      setProducts(await load());
    } catch {
      /* keep the stale list */
    }
  }, [load]);

  const toggleActive = useCallback(async (p: ShopProduct) => {
    setProducts((prev) => prev?.map((x) => (x.id === p.id ? { ...x, active: !p.active } : x)));
    const update = trpc.market.update as unknown as { mutate: (i: { productId: string; active: boolean }) => Promise<{ ok: boolean }> };
    try {
      const r = await update.mutate({ productId: p.id, active: !p.active });
      if (!r.ok) void refresh();
    } catch {
      void refresh();
    }
  }, [trpc, refresh]);

  const remove = useCallback(async (p: ShopProduct) => {
    if (!window.confirm(`Remove “${p.title}” from your shop?`)) return;
    setProducts((prev) => prev?.filter((x) => x.id !== p.id));
    const rm = trpc.market.remove as unknown as { mutate: (i: { productId: string }) => Promise<{ ok: boolean }> };
    try {
      const r = await rm.mutate({ productId: p.id });
      if (!r.ok) void refresh();
    } catch {
      void refresh();
    }
  }, [trpc, refresh]);

  return (
    <div>
      {!composing && !editing ? (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="pri" size="sm" onClick={() => { setComposing(true); setError(null); }}>
            ＋ Add a product or service
          </Button>
        </div>
      ) : (
        <ProductComposer
          venueId={venueId}
          initial={editing}
          onDone={() => { setComposing(false); setEditing(null); void refresh(); }}
          onCancel={() => { setComposing(false); setEditing(null); }}
        />
      )}

      {error ? <p role="alert" style={{ color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}

      {products === undefined ? (
        <div style={{ height: 96, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />
      ) : products.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Nothing in your shop yet. Add what you sell — meal vouchers, gift cards, retail products,
          bookable experiences — and it shows on your public page. Online buying switches on soon.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {products.map((p) => (
            <li key={p.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "10px 12px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--card)", opacity: p.active ? 1 : 0.6 }}>
              {p.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                <img src={p.photoUrl} alt="" style={{ width: 52, height: 52, borderRadius: 10, objectFit: "cover", flexShrink: 0 }} />
              ) : (
                <span aria-hidden style={{ width: 52, height: 52, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name={p.kind === "service" ? "ticket" : "bag"} size={20} />
                </span>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 14, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title}
                </div>
                <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--ink-2)" }}>
                  {p.kind === "service" ? "Service" : "Product"} · <strong style={{ color: "var(--ink)" }}>{formatPence(p.pricePence, p.currency)}</strong>
                  {p.stock != null ? ` · ${p.stock === 0 ? "sold out" : `${p.stock} in stock`}` : ""}
                </div>
              </div>
              <span style={{ flexShrink: 0, fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999, color: p.active ? "var(--success)" : "var(--muted)", background: p.active ? "var(--success-tint)" : "var(--paper-2)" }}>
                {p.active ? "Live" : "Hidden"}
              </span>
              <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button type="button" onClick={() => { setEditing(p); setComposing(false); }} style={rowBtn} aria-label={`Edit ${p.title}`}><Icon name="edit" size={14} /></button>
                <button type="button" onClick={() => void toggleActive(p)} style={rowBtn} aria-label={p.active ? `Hide ${p.title}` : `Show ${p.title}`}><Icon name={p.active ? "eyeOff" : "eye"} size={14} /></button>
                <button type="button" onClick={() => void remove(p)} style={rowBtn} aria-label={`Remove ${p.title}`}><Icon name="trash" size={14} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const rowBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "grid",
  placeItems: "center",
  width: 32,
  height: 32,
  borderRadius: 10,
  border: "1px solid var(--line)",
  color: "var(--ink-2)",
  boxSizing: "border-box",
};

/** Create/edit form. `initial` non-null = editing that product (prefilled). */
function ProductComposer({
  venueId,
  initial,
  onDone,
  onCancel,
}: {
  venueId: string;
  initial: ShopProduct | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const trpc = useTrpc();
  const [kind, setKind] = useState<"product" | "service">(initial?.kind ?? "product");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? (initial.pricePence / 100).toFixed(2) : "");
  const [stock, setStock] = useState(initial?.stock != null ? String(initial.stock) : "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(initial?.photoUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onFilePicked = useCallback(async (file: File) => {
    setError(null);
    if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
      setError("Please choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is over 10 MB. Please choose a smaller file.");
      return;
    }
    setBusy(true);
    try {
      // Downscale + re-encode in the browser first (lib/prepareImage).
      const prepared = await prepareImage(file, "product");
      // Path starts with the venue id — the venue-media storage RLS authorises by that prefix.
      const ext = prepared.name.includes(".") ? prepared.name.split(".").pop() : "webp";
      const path = `${venueId}/product-${crypto.randomUUID()}.${ext}`;
      const supabase = getSupabaseBrowser();
      const { error: upErr } = await supabase.storage.from(VENUE_MEDIA_BUCKET).upload(path, prepared, { contentType: prepared.type, upsert: false });
      if (upErr) {
        setError(`Upload failed: ${upErr.message}`);
        return;
      }
      const { data } = supabase.storage.from(VENUE_MEDIA_BUCKET).getPublicUrl(path);
      setPhotoUrl(data.publicUrl);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [venueId]);

  const save = useCallback(async () => {
    setError(null);
    const pence = parsePriceToPence(price);
    if (title.trim().length < 3) return setError("Give it a name (at least 3 characters).");
    if (pence == null) return setError("Enter a price like 12.50.");
    if (pence < 50) return setError("The minimum price is £0.50 (card processing needs it).");
    const stockNum = stock.trim() === "" ? null : Number(stock);
    if (stockNum != null && (!Number.isInteger(stockNum) || stockNum < 0)) return setError("Stock must be a whole number (or leave it empty).");

    setBusy(true);
    try {
      if (initial) {
        const update = trpc.market.update as unknown as {
          mutate: (i: { productId: string; title: string; description: string | null; pricePence: number; stock: number | null; photoUrl: string | null }) => Promise<{ ok: boolean }>;
        };
        const r = await update.mutate({ productId: initial.id, title: title.trim(), description: description.trim() || null, pricePence: pence, stock: stockNum, photoUrl });
        if (!r.ok) return setError("Couldn't save — please try again.");
      } else {
        const create = trpc.market.create as unknown as {
          mutate: (i: { venueId: string; kind: "product" | "service"; title: string; description: string | null; pricePence: number; stock: number | null; photoUrl: string | null }) => Promise<{ ok: boolean }>;
        };
        const r = await create.mutate({ venueId, kind, title: title.trim(), description: description.trim() || null, pricePence: pence, stock: stockNum, photoUrl });
        if (!r.ok) return setError("Couldn't add that — please try again.");
      }
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, initial, kind, title, description, price, stock, photoUrl, onDone]);

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: "var(--space-4)", marginBottom: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontFamily: "var(--display)", fontSize: 15.5 }}>{initial ? "Edit" : "New product or service"}</strong>
        {!initial ? (
          <span style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setKind("product")} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={kind === "product" ? "crim" : "neutral"} size="sm">Product</Pill>
            </button>
            <button type="button" onClick={() => setKind("service")} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={kind === "service" ? "crim" : "neutral"} size="sm">Service / voucher</Pill>
            </button>
          </span>
        ) : null}
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "service" ? "e.g. £25 dinner voucher" : "e.g. House-blend coffee beans, 250g"} maxLength={120} aria-label="Title" style={field} disabled={busy} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} placeholder="A line or two — what is it, how is it collected or redeemed?" aria-label="Description" style={{ ...field, resize: "vertical", minHeight: 56 }} disabled={busy} />

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <label style={{ flex: "1 1 120px" }}>
          <span style={labelStyle}>Price (£)</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="12.50" aria-label="Price in pounds" style={field} disabled={busy} />
        </label>
        <label style={{ flex: "1 1 120px" }}>
          <span style={labelStyle}>Stock (optional)</span>
          <input value={stock} onChange={(e) => setStock(e.target.value)} inputMode="numeric" placeholder={kind === "service" ? "Usually empty" : "e.g. 20"} aria-label="Stock count" style={field} disabled={busy} />
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
          <img src={photoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: "cover" }} />
        ) : null}
        <Button variant="neutral" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          {photoUrl ? "Change photo" : "Add a photo"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={ALLOWED_MIME.join(",")}
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFilePicked(f); }}
        />
      </div>

      {error ? <p role="alert" style={{ margin: 0, color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add to shop"}
        </Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", marginBottom: 4 };
