/**
 * ListingDetail — /market/[id]: one C2C listing in full — photos, price/mode, description,
 * seller card, and the hand-off: "Message seller" opens a DM (existing chat machinery).
 * No in-app payment by design; the deal is agreed in chat and settled in person.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { MessageButton } from "./MessageButton";
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

export function ListingDetail({ listingId }: { listingId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const [listing, setListing] = useState<Listing | null | undefined>(undefined);
  const [photo, setPhoto] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.listings.byId as unknown as { query: (i: { listingId: string }) => Promise<Listing | null> };
    q.query({ listingId }).then((r) => { if (!cancelled) setListing(r ?? null); }).catch(() => { if (!cancelled) setListing(null); });
    return () => { cancelled = true; };
  }, [trpc, listingId]);

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
          ) : (
            <MessageButton profileId={listing.seller.id} variant="pri" label="Message seller" />
          )}
        </Card>

        <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Roam doesn&apos;t handle payment for local listings — agree the details in chat and meet
          somewhere public. Never send money to someone you haven&apos;t met.
        </p>
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" };
