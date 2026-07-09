/**
 * ListingDetail — /market/[id]: one C2C listing in full — photos, price/mode, description,
 * seller card, and the hand-off: "Message seller" opens a DM (existing chat machinery).
 * No in-app payment by design; the deal is agreed in chat and settled in person.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { useRouter } from "next/navigation";
import { Button } from "@roam/design";
import { formatPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";

interface Listing {
  id: string;
  title: string;
  description: string | null;
  pricePence: number | null;
  mode: "sell" | "swap" | "free";
  category: string;
  locality: string | null;
  photoUrls: string[];
  status: string;
  createdAt: string;
  seller: { id: string; displayName: string | null; handle: string | null; avatarUrl: string | null };
}

/** Listings already view-counted this page lifetime (guards SPA re-mount recounts). */
const viewedListings = new Set<string>();

export function ListingDetail({ listingId, initial }: { listingId: string; initial?: Listing | null }) {
  const trpc = useTrpc();
  const session = useSession();
  // Seeded from the server render when the route resolved the listing (SEO path): the full
  // content is in the initial HTML and the client fetch below is skipped.
  const [listing, setListing] = useState<Listing | null | undefined>(initial);
  const [photo, setPhoto] = useState(0);

  // Count the view once — identity-free, sellers see the tally on their listings.
  useEffect(() => {
    if (viewedListings.has(listingId)) return;
    viewedListings.add(listingId);
    const rec = trpc.listings.recordView as unknown as { mutate: (i: { listingId: string }) => Promise<{ ok: boolean }> };
    rec.mutate({ listingId }).catch(() => {});
  }, [trpc, listingId]);

  useEffect(() => {
    if (initial !== undefined) return; // server already resolved it for this render
    let cancelled = false;
    const q = trpc.listings.byId as unknown as { query: (i: { listingId: string }) => Promise<Listing | null> };
    q.query({ listingId }).then((r) => { if (!cancelled) setListing(r ?? null); }).catch(() => { if (!cancelled) setListing(null); });
    return () => { cancelled = true; };
  }, [trpc, listingId, initial]);

  if (listing === undefined) {
    return <main style={pageStyle}><div style={{ height: 360, borderRadius: 20, background: "var(--paper-2)" }} aria-hidden /></main>;
  }
  if (listing === null) {
    return (
      <main style={pageStyle}>
        <p style={{ color: "var(--ink-2)" }}>This listing is gone — it may have been sold or removed. <Link href="/market" style={{ color: "var(--crimson-700)" }}>Back to Market</Link></p>
      </main>
    );
  }

  const sellerName = listing.seller.displayName?.trim() || (listing.seller.handle ? `@${listing.seller.handle}` : "A local");
  const isOwn = session?.user?.id === listing.seller.id;

  return (
    <main style={pageStyle}>
      <Link href="/market" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-3)" }}>
        <Icon name="arrowLeft" size={14} /> Market
      </Link>

      <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <Card style={{ overflow: "hidden" }}>
          {listing.photoUrls.length > 0 ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
              <img src={listing.photoUrls[Math.min(photo, listing.photoUrls.length - 1)]} alt="" style={{ display: "block", width: "100%", maxHeight: 420, objectFit: "cover" }} />
              {listing.photoUrls.length > 1 ? (
                <div style={{ display: "flex", gap: 8, padding: "var(--space-2)" }}>
                  {listing.photoUrls.map((u, i) => (
                    <button key={u} type="button" onClick={() => setPhoto(i)} style={{ all: "unset", cursor: "pointer", borderRadius: 8, outline: i === photo ? "2px solid var(--crimson)" : "none" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
                      <img src={u} alt="" style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover", display: "block" }} />
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div aria-hidden style={{ height: 240, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
              <Icon name="tag" size={40} />
            </div>
          )}
          <div style={{ padding: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
              <div>
                <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22, margin: 0 }}>{listing.title}</h1>
                <div style={{ marginTop: 4, fontSize: 13, color: "var(--muted)" }}>
                  {listing.locality ?? "Nearby"} · {timeAgo(listing.createdAt)} · {listing.category}
                  {listing.status !== "live" ? ` · ${listing.status.toUpperCase()}` : ""}
                </div>
              </div>
              <strong style={{ fontFamily: "var(--display)", fontSize: 24, color: "var(--ink-hi)" }}>
                {listing.mode === "free" ? "Free" : listing.mode === "swap" ? "Swap" : listing.pricePence != null ? formatPence(listing.pricePence) : ""}
              </strong>
            </div>
            {listing.description ? (
              <p style={{ margin: "var(--space-3) 0 0", fontSize: 14.5, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{listing.description}</p>
            ) : null}
          </div>
        </Card>

        <Card style={{ padding: "var(--space-4)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <Link href={`/u/${listing.seller.handle ?? listing.seller.id}`} style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "inherit", minWidth: 0 }}>
            {listing.seller.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
              <img src={listing.seller.avatarUrl} alt="" style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <span aria-hidden style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700 }}>
                {sellerName.replace(/^@/, "").charAt(0).toUpperCase()}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{sellerName}</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Seller · meets in {listing.locality ?? "your town"}</div>
            </div>
          </Link>
          {isOwn ? (
            <Pill variant="neutral" size="sm">Your listing</Pill>
          ) : session ? (
            <MessageSeller listing={listing} />
          ) : (
            <Link href="/account" style={{ textDecoration: "none" }}>
              <Button variant="neutral" size="sm">Sign in to message</Button>
            </Link>
          )}
        </Card>

        {!isOwn && session ? <ReportListing listingId={listing.id} /> : null}

        <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Roam doesn&apos;t handle payment for local listings — agree the details in chat and meet
          somewhere public. Never send money to someone you haven&apos;t met.
        </p>
      </div>
    </main>
  );
}

/**
 * MessageSeller — opens (or reuses) the DM and seeds it with the listing context, so the
 * seller knows exactly what the enquiry is about (the Facebook "Is this available?" moment).
 */
function MessageSeller({ listing }: { listing: { id: string; title: string; seller: { id: string } } }) {
  const trpc = useTrpc();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const go = useCallback(async () => {
    setBusy(true);
    try {
      const dt = trpc.chat.directThread as unknown as { mutate: (i: { profileId: string }) => Promise<{ threadId: string }> };
      const { threadId } = await dt.mutate({ profileId: listing.seller.id });
      const send = trpc.chat.sendMessage as unknown as { mutate: (i: { threadId: string; body: string }) => Promise<unknown> };
      const url = `${window.location.origin}/market/${listing.id}`;
      await send.mutate({ threadId, body: `About your listing “${listing.title}” — is it still available? ${url}` }).catch(() => {});
      router.push(`/threads/${threadId}`);
    } catch {
      setBusy(false);
    }
  }, [trpc, router, listing]);

  return (
    <Button variant="pri" size="sm" onClick={() => void go()} disabled={busy}>
      {busy ? "Opening chat…" : "Message seller"}
    </Button>
  );
}

/** ReportListing — a quiet flag-for-review affordance (moderation.reportListing). */
function ReportListing({ listingId }: { listingId: string }) {
  const trpc = useTrpc();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  if (state === "done") {
    return <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>Reported — thanks, we’ll take a look.</p>;
  }
  return (
    <button
      type="button"
      disabled={state === "busy"}
      onClick={() => {
        const detail = window.prompt("What’s wrong with this listing? (optional)") ?? undefined;
        setState("busy");
        const rep = trpc.moderation.reportListing as unknown as { mutate: (i: { listingId: string; detail?: string }) => Promise<{ ok: boolean }> };
        rep.mutate({ listingId, ...(detail?.trim() ? { detail: detail.trim() } : {}) })
          .then(() => setState("done"))
          .catch(() => setState("idle"));
      }}
      style={{ all: "unset", cursor: "pointer", fontSize: 12, color: "var(--muted)", textDecoration: "underline" }}
    >
      Report this listing
    </button>
  );
}

const pageStyle: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" };
