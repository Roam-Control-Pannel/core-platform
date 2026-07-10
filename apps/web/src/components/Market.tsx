/**
 * Market — /market, per the improved Market design: ONE town-scoped shopping surface with
 * two modes behind a toggle.
 *
 *   Shops       — the B2C feed: every product/voucher across the town's claimed venue
 *                 shops (MarketShops; cards land on the venue's Shop tab to buy).
 *   Marketplace — the C2C buy/sell/swap grid: peer listings, message-the-seller hand-off,
 *                 the composer, and "Your listings" management.
 *
 * Shared header: ROAM MARKET kicker, mode-aware headline, one search field filtering
 * whichever mode is active, the place switcher, and a mode-aware Sell button (Shops →
 * the business dashboard; Marketplace → the listing composer). Deep-linkable:
 * /market?view=shops|market&mine=1. C2C stays payment-free by design (agree in chat,
 * settle in person — zero KYC friction for casual sellers).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Pill, Seg, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { getSupabaseBrowser } from "../lib/supabase";
import { formatPence, parsePriceToPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";
import { MarketShops, HeartButton } from "./MarketShops";
import { useWishlist } from "../lib/wishlist";
import { prepareImage } from "../lib/prepareImage";
import { imageFilesFrom, moveItem, thumbButtonStyle } from "../lib/composerMedia";

const CATEGORIES = ["furniture", "electronics", "clothing", "kids", "home", "garden", "sports", "books", "vehicles", "other"] as const;

/** Great-circle miles between two points — the listing cards' "0.8 mi" pill. */
function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const R = 6371e3;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return (2 * R * Math.asin(Math.sqrt(h))) / 1609.344;
}

/** The listing card's status badge — coloured per the mock. */
function listingBadge(t: ReturnType<typeof useTranslations>, l: { mode: Mode; status: string; createdAt: string }): { label: string; color: string } {
  if (l.status === "sold") return { label: t("badge.sold"), color: "var(--muted)" };
  if (l.status === "removed") return { label: t("badge.removed"), color: "var(--muted)" };
  if (l.mode === "free") return { label: t("badge.free"), color: "var(--success)" };
  if (l.mode === "swap") return { label: t("badge.swapOk"), color: "var(--gold)" };
  const ageH = (Date.now() - new Date(l.createdAt).getTime()) / 36e5;
  return ageH < 72 ? { label: t("badge.newIn"), color: "var(--crimson-700)" } : { label: t("badge.forSale"), color: "var(--ink-2)" };
}
type Cat = (typeof CATEGORIES)[number];
type Mode = "sell" | "swap" | "free";

interface Listing {
  id: string;
  views?: number;
  lat?: number | null;
  lng?: number | null;
  title: string;
  description: string | null;
  pricePence: number | null;
  mode: Mode;
  category: string;
  locality: string | null;
  photoUrls: string[];
  status: string;
  createdAt: string;
  seller: { id: string; displayName: string | null; handle: string | null; avatarUrl: string | null };
}

/**
 * SurfaceToggle — the Shops | Marketplace switch, per the improved design: a soft tinted
 * track with the active option raised as a white pill (crimson icon + label) and the
 * inactive one resting muted. Bigger than the standard Seg on purpose — this is the page's
 * primary mode switch, not a filter.
 */
function SurfaceToggle({ value, onChange }: { value: "shops" | "market"; onChange: (v: "shops" | "market") => void }) {
  const t = useTranslations("market");
  const options = [
    { v: "shops" as const, label: t("toggle.shops"), icon: "bag" as const },
    { v: "market" as const, label: t("toggle.marketplace"), icon: "gift" as const },
  ];
  return (
    <div role="tablist" aria-label={t("toggle.aria")} style={{ display: "inline-flex", gap: 4, padding: 6, borderRadius: 999, background: "var(--paper-2)", flexShrink: 0 }}>
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.v)}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 18px",
              borderRadius: 999,
              fontFamily: "var(--ui)",
              fontWeight: 700,
              fontSize: 15,
              color: on ? "var(--crimson-700)" : "var(--muted)",
              background: on ? "var(--card)" : "transparent",
              boxShadow: on ? "var(--shadow-key)" : "none",
              transition: "background var(--motion-transition) var(--ease), color var(--motion-transition) var(--ease)",
            }}
          >
            <Icon name={o.icon} size={17} /> {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Market() {
  const t = useTranslations("market");
  const trpc = useTrpc();
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();
  const [listings, setListings] = useState<Listing[] | undefined>(undefined);
  const [category, setCategory] = useState<Cat | null>(null);
  const [mode, setMode] = useState<"all" | Mode>("all");
  const [view, setView] = useState<"browse" | "mine">("browse");
  const [composing, setComposing] = useState(false);
  // Which half of the market: venue shops (B2C) or peer listings (C2C). Deep-linkable.
  const [surface, setSurface] = useState<"shops" | "market">("shops");
  const [query, setQuery] = useState("");
  const [savedOnly, setSavedOnly] = useState(false);
  const wish = useWishlist("listing");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "market" || params.get("mine") === "1") setSurface("market");
    if (params.get("mine") === "1") setView("mine");
  }, []);

  const load = useCallback(async () => {
    if (view === "mine") {
      const mine = trpc.listings.mine as unknown as { query: () => Promise<Listing[]> };
      return mine.query();
    }
    const browse = trpc.listings.browse as unknown as {
      query: (i: { localityName: string; category?: Cat; mode?: Mode }) => Promise<Listing[]>;
    };
    return browse.query({ localityName: place.name, ...(category ? { category } : {}), ...(mode !== "all" ? { mode } : {}) });
  }, [trpc, view, place.name, category, mode]);

  useEffect(() => {
    let cancelled = false;
    setListings(undefined);
    load().then((r) => { if (!cancelled) setListings(Array.isArray(r) ? r : []); }).catch(() => { if (!cancelled) setListings([]); });
    return () => { cancelled = true; };
  }, [load]);

  const setStatus = useCallback(async (id: string, status: "sold" | "removed" | "live") => {
    const mut = trpc.listings.setStatus as unknown as { mutate: (i: { listingId: string; status: string }) => Promise<{ ok: boolean }> };
    try { await mut.mutate({ listingId: id, status }); setListings(await load()); } catch { /* keep list */ }
  }, [trpc, load]);

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, letterSpacing: ".09em", textTransform: "uppercase", color: surface === "shops" ? "var(--crimson-700)" : "var(--gold)", marginBottom: 6 }}>
            {surface === "shops" ? t("kicker.shops") : t("kicker.marketplace")}
          </div>
          <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}>
            {surface === "shops" ? t("headline.shops") : t("headline.marketplace")}
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--ink-2)" }}>
            {t.rich(surface === "shops" ? "sub.shops" : "sub.marketplace", {
              place: place.name,
              strong: (chunks) => <strong style={{ color: "var(--ink)" }}>{chunks}</strong>,
            })}
          </p>
        </div>
        <SurfaceToggle value={surface} onChange={setSurface} />
      </header>

      {/* Search · place · sell — one control row for both modes. */}
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={surface === "shops" ? t("searchPlaceholder.shops") : t("searchPlaceholder.marketplace")}
          aria-label={t("searchAria")}
          style={{ flex: "1 1 260px", boxSizing: "border-box", padding: "11px 18px", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 999, fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none", boxShadow: "var(--shadow-key)" }}
        />
        <PlaceSwitcher value={place} onChange={setPlace} />
        {surface === "shops" ? (
          <Link href="/dashboard" style={{ textDecoration: "none" }}>
            <Button variant="pri" size="sm">{t("sellOnRoam")}</Button>
          </Link>
        ) : (
          <>
            {session ? (
              <Seg options={[{ value: "browse", label: t("view.browse") }, { value: "mine", label: t("view.mine") }]} value={view} onChange={(v) => setView(v as "browse" | "mine")} />
            ) : null}
            <Button variant="pri" size="sm" onClick={() => setComposing((v) => !v)}>{t("listAnItem")}</Button>
          </>
        )}
      </div>

      {surface === "shops" ? (
        <MarketShops localityName={place.name} query={query} />
      ) : (
      <>
      {composing ? (
        session ? (
          <ListingComposer
            localityName={place.name}
            lat={place.lat}
            lng={place.lng}
            onDone={() => { setComposing(false); void load().then(setListings).catch(() => {}); }}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)" }}>
              {t.rich("signInToPost", {
                link: (chunks) => <Link href="/account" style={{ color: "var(--crimson-700)", fontWeight: 600 }}>{chunks}</Link>,
              })}
            </p>
          </Card>
        )
      ) : null}

      {view === "browse" ? (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <Seg options={[{ value: "all", label: t("filter.all") }, { value: "sell", label: t("filter.forSale") }, { value: "swap", label: t("filter.swap") }, { value: "free", label: t("filter.free") }]} value={mode} onChange={(v) => setMode(v as typeof mode)} />
          <button onClick={() => setCategory(null)} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={category === null ? "crim" : "neutral"} size="sm">{t("allCategories")}</Pill>
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} onClick={() => setCategory(c)} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={category === c ? "crim" : "neutral"} size="sm">{t(`categories.${c}`)}</Pill>
            </button>
          ))}
          {wish.saved.size > 0 ? (
            <button onClick={() => setSavedOnly((v) => !v)} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={savedOnly ? "crim" : "neutral"} size="sm">♥ {t("saved")} · {wish.saved.size}</Pill>
            </button>
          ) : null}
        </div>
      ) : null}

      {listings === undefined ? (
        <div style={{ height: 220, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />
      ) : listings.filter((l) => (!savedOnly || wish.isSaved(l.id)) && (!query.trim() || l.title.toLowerCase().includes(query.trim().toLowerCase()))).length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
          {view === "mine" ? t("emptyMine") : t("emptyBrowse", { place: place.name })}
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "var(--space-3)" }}>
          {listings.filter((l) => (!savedOnly || wish.isSaved(l.id)) && (!query.trim() || l.title.toLowerCase().includes(query.trim().toLowerCase()))).map((l) => (
            <Card key={l.id} style={{ overflow: "hidden", position: "relative", opacity: l.status === "live" ? 1 : 0.6 }}>
              <Link href={`/market/${l.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div style={{ position: "relative" }}>
                  {l.photoUrls[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                    <img src={l.photoUrls[0]} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 230, objectFit: "cover" }} />
                  ) : (
                    <div aria-hidden style={{ height: 230, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
                      <Icon name="tag" size={32} />
                    </div>
                  )}
                  {(() => { const b = listingBadge(t, l); return (
                    <span style={{ position: "absolute", top: "var(--space-3)", left: "var(--space-3)", display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 11px", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: b.color, background: "rgba(255,255,255,.94)", boxShadow: "var(--shadow-key)" }}>
                      {b.label}
                    </span>
                  ); })()}
                </div>
                <div style={{ padding: "var(--space-3) var(--space-4) var(--space-4)", display: "grid", gap: 6 }}>
                  <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15.5, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 18, color: l.mode === "free" ? "var(--success)" : l.mode === "swap" ? "var(--gold)" : "var(--ink-hi)" }}>
                      {l.mode === "free" ? t("price.free") : l.mode === "swap" ? t("price.swap") : l.pricePence != null ? formatPence(l.pricePence) : ""}
                    </strong>
                    {l.lat != null && l.lng != null ? (
                      <span style={{ padding: "3px 10px", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, color: "var(--crimson-700)", background: "var(--crimson-tint)", whiteSpace: "nowrap" }}>
                        {t("miles", { miles: milesBetween(place.lat, place.lng, l.lat, l.lng).toFixed(1) })}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{l.locality ?? t("nearby")} · {timeAgo(l.createdAt)}{view === "mine" && l.views != null ? ` · ${t("views", { count: l.views })}` : ""}</div>
                </div>
              </Link>
              <HeartButton saved={wish.isSaved(l.id)} onToggle={() => wish.toggle(l.id)} label={l.title} />
              {view === "mine" ? (
                <div style={{ display: "flex", gap: 6, padding: "0 var(--space-3) var(--space-3)" }}>
                  {l.status === "live" ? (
                    <>
                      <Button variant="neutral" size="sm" onClick={() => void setStatus(l.id, "sold")}>{t("markSold")}</Button>
                      <Button variant="neutral" size="sm" onClick={() => void setStatus(l.id, "removed")}>{t("remove")}</Button>
                    </>
                  ) : (
                    <Button variant="neutral" size="sm" onClick={() => void setStatus(l.id, "live")}>{t("relist")}</Button>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
      </>
      )}
    </main>
  );
}

/** Post a listing: mode, title, price (sell only), category, description, up to 4 photos. */
function ListingComposer({ localityName, lat, lng, onDone, onCancel }: { localityName: string; lat: number; lng: number; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations("market");
  const trpc = useTrpc();
  const session = useSession();
  const [mode, setMode] = useState<Mode>("sell");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState<Cat>("other");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [progress, setProgress] = useState<string | null>(null);

  const addPhotos = useCallback(async (files: FileList | File[]) => {
    const uid = session?.user?.id;
    if (!uid) return;
    const room = 4 - photos.length;
    if (room <= 0) return;
    const chosen = Array.from(files)
      .filter((f) => ["image/jpeg", "image/png", "image/webp"].includes(f.type) && f.size <= 10 * 1024 * 1024)
      .slice(0, room);
    if (chosen.length === 0) {
      setError(t("composer.photoRules"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const [i, file] of chosen.entries()) {
        if (chosen.length > 1) setProgress(t("composer.uploadingProgress", { current: i + 1, total: chosen.length }));
        // Downscale + re-encode in the browser first (lib/prepareImage).
        const prepared = await prepareImage(file, "listing");
        const ext = prepared.name.includes(".") ? prepared.name.split(".").pop() : "webp";
        const path = `${uid}/listing-${crypto.randomUUID()}.${ext}`;
        const supabase = getSupabaseBrowser();
        const { error: upErr } = await supabase.storage.from("profile-media").upload(path, prepared, { contentType: prepared.type });
        if (upErr) { setError(t("composer.uploadFailed", { message: upErr.message })); return; }
        const { data } = supabase.storage.from("profile-media").getPublicUrl(path);
        setPhotos((p) => [...p, data.publicUrl]);
      }
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [session, photos.length]);

  const post = useCallback(async () => {
    setError(null);
    const pence = mode === "sell" ? parsePriceToPence(price) : null;
    if (title.trim().length < 3) return setError(t("composer.titleMin"));
    if (mode === "sell" && (pence == null || pence <= 0)) return setError(t("composer.priceInvalid"));
    setBusy(true);
    try {
      const create = trpc.listings.create as unknown as {
        mutate: (i: { title: string; description: string | null; pricePence: number | null; mode: Mode; category: Cat; locality: string; lat: number; lng: number; photoUrls: string[] }) => Promise<{ ok: boolean }>;
      };
      const r = await create.mutate({ title: title.trim(), description: description.trim() || null, pricePence: pence, mode, category, locality: localityName, lat, lng, photoUrls: photos });
      if (!r.ok) return setError(t("composer.postFailedRetry"));
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("composer.postFailed"));
    } finally {
      setBusy(false);
    }
  }, [trpc, mode, title, description, price, category, photos, localityName, lat, lng, onDone]);

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: "var(--display)", fontSize: 15.5 }}>{t("composer.title", { place: localityName })}</strong>
        <Seg options={[{ value: "sell", label: t("composer.modeSell") }, { value: "swap", label: t("composer.modeSwap") }, { value: "free", label: t("composer.modeFree") }]} value={mode} onChange={(v) => setMode(v as Mode)} />
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("composer.titlePlaceholder")} maxLength={120} aria-label={t("composer.titleAria")} style={fieldStyle} disabled={busy} />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {mode === "sell" ? (
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder={t("composer.pricePlaceholder")} aria-label={t("composer.priceAria")} style={{ ...fieldStyle, flex: "1 1 120px" }} disabled={busy} />
        ) : null}
        <select value={category} onChange={(e) => setCategory(e.target.value as Cat)} aria-label={t("composer.categoryAria")} style={{ ...fieldStyle, flex: "1 1 140px" }} disabled={busy}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`categories.${c}`)}</option>
          ))}
        </select>
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} onPaste={(e) => { const fs = imageFilesFrom(e.clipboardData); if (fs.length > 0) { e.preventDefault(); void addPhotos(fs); } }} rows={2} maxLength={2000} placeholder={t("composer.descriptionPlaceholder")} aria-label={t("composer.descriptionAria")} style={{ ...fieldStyle, resize: "vertical", minHeight: 56 }} disabled={busy} />
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { const fs = imageFilesFrom(e.dataTransfer); if (fs.length > 0) { e.preventDefault(); void addPhotos(fs); } }}
      >
        {photos.map((u, i) => (
          <div key={u} style={{ position: "relative" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
            <img src={u} alt="" style={{ width: 56, height: 56, borderRadius: 10, objectFit: "cover", display: "block" }} />
            {i === 0 ? (
              <span style={{ position: "absolute", top: 2, left: 2, fontFamily: "var(--mono)", fontSize: 8, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "#fff", background: "rgba(33,29,26,.72)", borderRadius: 4, padding: "1px 4px" }}>{t("composer.cover")}</span>
            ) : null}
            <button type="button" aria-label={t("composer.removePhoto")} onClick={() => setPhotos((p) => p.filter((x) => x !== u))} style={{ position: "absolute", top: -6, right: -6, ...thumbButtonStyle }}>×</button>
            {photos.length > 1 ? (
              <div style={{ position: "absolute", bottom: -6, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 3 }}>
                <button type="button" aria-label={t("composer.moveEarlier")} disabled={i === 0} onClick={() => setPhotos((p) => moveItem(p, i, -1))} style={{ ...thumbButtonStyle, opacity: i === 0 ? 0.35 : 1 }}>‹</button>
                <button type="button" aria-label={t("composer.moveLater")} disabled={i === photos.length - 1} onClick={() => setPhotos((p) => moveItem(p, i, 1))} style={{ ...thumbButtonStyle, opacity: i === photos.length - 1 ? 0.35 : 1 }}>›</button>
              </div>
            ) : null}
          </div>
        ))}
        {photos.length < 4 ? (
          <Button variant="neutral" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? (progress ?? t("composer.uploading")) : t("composer.addPhotos")}</Button>
        ) : null}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: "none" }} onChange={(e) => { const fs = e.target.files; if (fs && fs.length > 0) void addPhotos(fs); }} />
      </div>
      {error ? <p role="alert" style={{ margin: 0, color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" size="sm" onClick={() => void post()} disabled={busy}>{busy ? t("composer.posting") : t("composer.post")}</Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>{t("composer.cancel")}</Button>
      </div>
    </Card>
  );
}

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "10px 12px",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16,
  color: "var(--ink)",
  outline: "none",
  width: "100%",
};
