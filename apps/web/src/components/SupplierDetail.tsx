/**
 * SupplierDetail — one supplier's public page (C3-b). Reads suppliers.bySlug (live+approved for the
 * public, or the owner's own at any status via RLS) and renders name / logo / description / links.
 * Read-only in v1; owner self-management is a later surface (the suppliers.update API already exists).
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTrpc } from "./TrpcProvider";

interface SupplierOrg {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  website: string | null;
  locality: string | null;
  logoUrl: string | null;
  links: { label: string; url: string }[];
  createdAt: string;
}

export function SupplierDetail({ slug }: { slug: string }) {
  const trpc = useTrpc();
  const [org, setOrg] = useState<SupplierOrg | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.suppliers.bySlug as unknown as { query: (i: { slug: string }) => Promise<SupplierOrg | null> };
    q.query({ slug }).then((r) => { if (!cancelled) setOrg(r); }).catch(() => { if (!cancelled) setOrg(null); });
    return () => { cancelled = true; };
  }, [trpc, slug]);

  if (org === undefined) {
    return <main style={wrap}><p style={{ color: "var(--ink-2)" }}>Loading…</p></main>;
  }
  if (!org) {
    return (
      <main style={wrap}>
        <p style={{ color: "var(--ink-2)" }}>This supplier isn't available.</p>
        <Link href="/suppliers" style={{ color: "var(--crimson-700)" }}>← All suppliers</Link>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <Link href="/suppliers" style={{ color: "var(--crimson-700)", fontSize: 13, textDecoration: "none" }}>← All suppliers</Link>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", margin: "var(--space-3) 0 var(--space-2)" }}>
        {org.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logoUrl} alt="" width={56} height={56} style={{ borderRadius: 10, objectFit: "cover", flexShrink: 0 }} />
        ) : null}
        <div>
          <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>{org.name}</h1>
          <div style={{ marginTop: 2, fontSize: 13.5, color: "var(--ink-2)" }}>{[org.category, org.locality].filter(Boolean).join(" · ")}</div>
        </div>
      </div>

      {org.description ? (
        <p style={{ lineHeight: 1.6, color: "var(--ink-2)", margin: "var(--space-3) 0", whiteSpace: "pre-wrap" }}>{org.description}</p>
      ) : null}

      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
        {org.website ? (
          <a href={org.website} target="_blank" rel="noopener noreferrer nofollow" style={pill}>Website ↗</a>
        ) : null}
        {org.links.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" style={pill}>{l.label} ↗</a>
        ))}
      </div>
    </main>
  );
}

const wrap: React.CSSProperties = { maxWidth: 680, margin: "0 auto", padding: "var(--space-6) var(--space-4)" };
const pill: React.CSSProperties = { display: "inline-block", border: "1px solid var(--line)", borderRadius: 999, padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "var(--ink)", textDecoration: "none" };
