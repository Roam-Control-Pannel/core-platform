/**
 * Market — /market: the C2C buy/sell/swap marketplace (marketplace PR 4). Town-scoped via
 * the shared current place; category chips + mode filter; a listing composer (photos to the
 * profile-media bucket under the caller's uid prefix — same storage RLS as avatars); and a
 * "Your listings" view with mark-sold/remove. No payments: buyers message the seller (chat)
 * and settle in person — zero KYC friction for casual sellers.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, Button, Pill, Seg, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { getSupabaseBrowser } from "../lib/supabase";
import { formatPence, parsePriceToPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";

const CATEGORIES = ["furniture", "electronics", "clothing", "kids", "home", "garden", "sports", "books", "vehicles", "other"] as const;
type Cat = (typeof CATEGORIES)[number];
type Mode = "sell" | "swap" | "free";

interface Listing {
  id: string;
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

export function Market() {
  const trpc = useTrpc();
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();
  const [listings, setListings] = useState<Listing[] | undefined>(undefined);
  const [category, setCategory] = useState<Cat | null>(null);
  const [mode, setMode] = useState<"all" | Mode>("all");
  const [view, setView] = useState<"browse" | "mine">("browse");
  const [composing, setComposing] = useState(false);

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
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <div>
          <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0 }}>Market</h1>
          <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: 13.5, color: "var(--ink-2)" }}>
            Buy, sell and swap with locals in <PlaceSwitcher value={place} onChange={setPlace} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          {session ? (
            <Seg options={[{ value: "browse", label: "Browse" }, { value: "mine", label: "Your listings" }]} value={view} onChange={(v) => setView(v as "browse" | "mine")} />
          ) : null}
          <Button variant="pri" size="sm" onClick={() => setComposing((v) => !v)}>＋ New listing</Button>
        </div>
      </header>

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
              <Link href="/account" style={{ color: "var(--crimson-700)", fontWeight: 600 }}>Sign in</Link> to post a listing — it takes a minute.
            </p>
          </Card>
        )
      ) : null}

      {view === "browse" ? (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <Seg options={[{ value: "all", label: "All" }, { value: "sell", label: "For sale" }, { value: "swap", label: "Swap" }, { value: "free", label: "Free" }]} value={mode} onChange={(v) => setMode(v as typeof mode)} />
          <button onClick={() => setCategory(null)} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={category === null ? "crim" : "neutral"} size="sm">All categories</Pill>
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} onClick={() => setCategory(c)} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={category === c ? "crim" : "neutral"} size="sm">{c[0]!.toUpperCase() + c.slice(1)}</Pill>
            </button>
          ))}
        </div>
      ) : null}

      {listings === undefined ? (
        <div style={{ height: 220, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />
      ) : listings.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
          {view === "mine" ? "You haven't listed anything yet." : `Nothing listed in ${place.name} yet — be the first.`}
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "var(--space-3)" }}>
          {listings.map((l) => (
            <Card key={l.id} style={{ overflow: "hidden", opacity: l.status === "live" ? 1 : 0.6 }}>
              <Link href={`/market/${l.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                {l.photoUrls[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                  <img src={l.photoUrls[0]} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 150, objectFit: "cover" }} />
                ) : (
                  <div aria-hidden style={{ height: 150, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
                    <Icon name="tag" size={28} />
                  </div>
                )}
                <div style={{ padding: "var(--space-3)", display: "grid", gap: 4 }}>
                  <strong style={{ fontFamily: "var(--display)", fontSize: 15, color: "var(--ink-hi)" }}>
                    {l.mode === "free" ? "Free" : l.mode === "swap" ? "Swap" : l.pricePence != null ? formatPence(l.pricePence) : ""}
                  </strong>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>{l.locality ?? "Nearby"} · {timeAgo(l.createdAt)}{l.status !== "live" ? ` · ${l.status}` : ""}</div>
                </div>
              </Link>
              {view === "mine" ? (
                <div style={{ display: "flex", gap: 6, padding: "0 var(--space-3) var(--space-3)" }}>
                  {l.status === "live" ? (
                    <>
                      <Button variant="neutral" size="sm" onClick={() => void setStatus(l.id, "sold")}>Mark sold</Button>
                      <Button variant="neutral" size="sm" onClick={() => void setStatus(l.id, "removed")}>Remove</Button>
                    </>
                  ) : (
                    <Button variant="neutral" size="sm" onClick={() => void setStatus(l.id, "live")}>Relist</Button>
                  )}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}

/** Post a listing: mode, title, price (sell only), category, description, up to 4 photos. */
function ListingComposer({ localityName, lat, lng, onDone, onCancel }: { localityName: string; lat: number; lng: number; onDone: () => void; onCancel: () => void }) {
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

  const addPhoto = useCallback(async (file: File) => {
    const uid = session?.user?.id;
    if (!uid || photos.length >= 4) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError("Photos must be JPEG/PNG/WebP under 10 MB.");
      return;
    }
    setBusy(true);
    try {
      const ext = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
      const path = `${uid}/listing-${crypto.randomUUID()}.${ext}`;
      const supabase = getSupabaseBrowser();
      const { error: upErr } = await supabase.storage.from("profile-media").upload(path, file, { contentType: file.type });
      if (upErr) { setError(`Upload failed: ${upErr.message}`); return; }
      const { data } = supabase.storage.from("profile-media").getPublicUrl(path);
      setPhotos((p) => [...p, data.publicUrl]);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [session, photos.length]);

  const post = useCallback(async () => {
    setError(null);
    const pence = mode === "sell" ? parsePriceToPence(price) : null;
    if (title.trim().length < 3) return setError("Give it a title (at least 3 characters).");
    if (mode === "sell" && (pence == null || pence <= 0)) return setError("Enter a price like 25 or 12.50.");
    setBusy(true);
    try {
      const create = trpc.listings.create as unknown as {
        mutate: (i: { title: string; description: string | null; pricePence: number | null; mode: Mode; category: Cat; locality: string; lat: number; lng: number; photoUrls: string[] }) => Promise<{ ok: boolean }>;
      };
      const r = await create.mutate({ title: title.trim(), description: description.trim() || null, pricePence: pence, mode, category, locality: localityName, lat, lng, photoUrls: photos });
      if (!r.ok) return setError("Couldn't post that — try again.");
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't post that.");
    } finally {
      setBusy(false);
    }
  }, [trpc, mode, title, description, price, category, photos, localityName, lat, lng, onDone]);

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: "var(--display)", fontSize: 15.5 }}>New listing in {localityName}</strong>
        <Seg options={[{ value: "sell", label: "Sell" }, { value: "swap", label: "Swap" }, { value: "free", label: "Free" }]} value={mode} onChange={(v) => setMode(v as Mode)} />
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What are you listing?" maxLength={120} aria-label="Title" style={fieldStyle} disabled={busy} />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {mode === "sell" ? (
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price (£)" aria-label="Price" style={{ ...fieldStyle, flex: "1 1 120px" }} disabled={busy} />
        ) : null}
        <select value={category} onChange={(e) => setCategory(e.target.value as Cat)} aria-label="Category" style={{ ...fieldStyle, flex: "1 1 140px" }} disabled={busy}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>
          ))}
        </select>
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} placeholder="Condition, size, pickup details…" aria-label="Description" style={{ ...fieldStyle, resize: "vertical", minHeight: 56 }} disabled={busy} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {photos.map((u) => (
          // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
          <img key={u} src={u} alt="" style={{ width: 56, height: 56, borderRadius: 10, objectFit: "cover" }} />
        ))}
        {photos.length < 4 ? (
          <Button variant="neutral" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>Add photo</Button>
        ) : null}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void addPhoto(f); }} />
      </div>
      {error ? <p role="alert" style={{ margin: 0, color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" size="sm" onClick={() => void post()} disabled={busy}>{busy ? "Posting…" : "Post listing"}</Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
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
