/**
 * BusinessStats — the at-a-glance strip on the business dashboard: a row of stat cards
 * (Followers · Posts · Push credits) plus a Followers card showing who follows the venue.
 *
 * Data: social.venueFollowers (count + recent profiles — follows_read is public), credits.balance
 * (owner reads their own), and posts.mine (count). Each loads independently; a failed one just
 * shows a dash, never blocking the rest.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card , Icon, type IconName } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

interface Follower {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function followerName(f: Follower): string {
  if (f.displayName && f.displayName.trim()) return f.displayName.trim();
  if (f.handle && f.handle.trim()) return `@${f.handle.trim()}`;
  return "Roam member";
}

export function BusinessStats({ venueId, rating, ratingCount }: { venueId: string; rating: number | null; ratingCount: number | null }) {
  const trpc = useTrpc();
  const [followerCount, setFollowerCount] = useState<number | null>(null);
  const [followers, setFollowers] = useState<Follower[]>([]);
  const [posts, setPosts] = useState<number | null>(null);
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const vf = trpc.social.venueFollowers as unknown as { query: (i: { venueId: string }) => Promise<{ ok: boolean; count: number; followers: Follower[] }> };
    const mine = trpc.posts.mine as unknown as { query: (i: { venueId: string }) => Promise<{ id: string }[]> };
    const bal = trpc.credits.balance as unknown as { query: (i: { venueId: string }) => Promise<{ balance: number }> };
    vf.query({ venueId }).then((r) => { if (!cancelled) { setFollowerCount(r.count ?? 0); setFollowers(r.followers ?? []); } }).catch(() => {});
    mine.query({ venueId }).then((r) => { if (!cancelled) setPosts(Array.isArray(r) ? r.length : 0); }).catch(() => {});
    bal.query({ venueId }).then((r) => { if (!cancelled) setCredits(r.balance ?? 0); }).catch(() => {});
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  const num = (n: number | null) => (n == null ? "–" : n.toLocaleString());

  return (
    <div style={{ display: "grid", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "var(--space-3)" }}>
        <StatCard glyph="heart" label="Followers" value={num(followerCount)} />
        <StatCard glyph="megaphone" label="Posts" value={num(posts)} />
        <StatCard glyph="sparkle" label="Push credits" value={num(credits)} href={`/dashboard/${venueId}`} />
        <StatCard glyph="star" label="Rating" value={rating != null ? rating.toFixed(1) : "–"} sub={ratingCount ? `${ratingCount.toLocaleString()} reviews` : "No reviews yet"} />
      </div>

      <Card style={{ padding: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span aria-hidden style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}><Icon name="heart" size={15} /></span>
            <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, margin: 0 }}>
              Followers{followerCount != null ? ` · ${followerCount.toLocaleString()}` : ""}
            </h2>
          </div>
        </div>
        {followerCount === 0 ? (
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5 }}>
            No followers yet. People who follow you get your offers &amp; promotions — share a local post to get noticed.
          </p>
        ) : followers.length === 0 ? (
          <div style={{ height: 36, borderRadius: 999, background: "var(--paper-2)", width: "60%" }} />
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {followers.map((f) => (
              <Link key={f.id} href={`/u/${f.handle ?? f.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 12px 4px 5px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)", textDecoration: "none", color: "var(--ink)" }}>
                <FollowerAvatar f={f} size={24} />
                <span style={{ fontSize: 13, fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{followerName(f)}</span>
              </Link>
            ))}
            {followerCount != null && followerCount > followers.length ? (
              <span style={{ display: "inline-flex", alignItems: "center", padding: "5px 12px", borderRadius: 999, background: "var(--crimson-tint)", color: "var(--crimson-700)", fontSize: 13, fontWeight: 600 }}>
                +{(followerCount - followers.length).toLocaleString()} more
              </span>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ glyph, label, value, sub, href }: { glyph: IconName; label: string; value: string; sub?: string; href?: string }) {
  const inner = (
    <Card style={{ padding: "var(--space-4)", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Icon name={glyph} size={15} style={{ color: "var(--crimson-700)" }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>{label}</span>
      </div>
      <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 28, letterSpacing: "-.02em", color: "var(--ink-hi)", lineHeight: 1 }}>{value}</div>
      {sub ? <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--muted)" }}>{sub}</div> : null}
    </Card>
  );
  return href ? <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>{inner}</Link> : inner;
}

function FollowerAvatar({ f, size }: { f: Follower; size: number }) {
  if (f.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={f.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {followerName(f).replace(/^@/, "").charAt(0).toUpperCase() || "·"}
    </span>
  );
}
