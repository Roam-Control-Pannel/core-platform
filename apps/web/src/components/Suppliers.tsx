/**
 * Suppliers — the F2G supplier directory + self-serve "add your business" composer (C3-b).
 *
 * The directory lists only live, approved suppliers (the server's moderation hard gate). The composer
 * is gated on live membership (suppliers.canPost pre-flights; the server enforces via RLS), and a new
 * supplier is submitted as a DRAFT pending moderation — so the composer confirms "submitted for review"
 * rather than showing it live. Mirrors the Jobs board (list + just-in-time auth + inline composer).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTrpc, useSession } from "./TrpcProvider";
import { useChannel } from "./ChannelProvider";
import { AuthModal } from "./AuthModal";

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

export function Suppliers() {
  const trpc = useTrpc();
  const session = useSession();
  const { isEnabled } = useChannel();

  const [orgs, setOrgs] = useState<SupplierOrg[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [canPost, setCanPost] = useState(false);
  const [composing, setComposing] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(() => {
    const list = trpc.suppliers.list as unknown as { query: (i: { limit: number }) => Promise<{ orgs: SupplierOrg[] }> };
    list.query({ limit: 50 })
      .then((r) => setOrgs(r.orgs))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load suppliers."));
  }, [trpc]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!session) { setCanPost(false); return; }
    let cancelled = false;
    const q = trpc.suppliers.canPost as unknown as { query: () => Promise<{ canPost: boolean }> };
    q.query().then((r) => { if (!cancelled) setCanPost(r.canPost); }).catch(() => {});
    return () => { cancelled = true; };
  }, [trpc, session]);

  if (!isEnabled("suppliers")) {
    return (
      <main style={pageWrap}>
        <p style={{ color: "var(--ink-2)", fontSize: 15 }}>The supplier directory isn't available here yet.</p>
      </main>
    );
  }

  return (
    <main style={pageWrap}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          Suppliers
        </div>
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 32, letterSpacing: "-.02em", margin: 0 }}>Trade suppliers</h1>
        <p style={{ color: "var(--ink-2)", margin: "6px 0 0", fontSize: 14.5, lineHeight: 1.5 }}>
          Wholesalers and services that supply local Food to Go members.
        </p>
      </header>

      <div style={{ marginBottom: "var(--space-5)" }}>
        {submitted ? (
          <p style={{ fontSize: 13.5, color: "#1F6B41", margin: 0 }}>Thanks — your business was submitted for review.</p>
        ) : composing ? (
          <SupplierComposer onDone={(created) => { setComposing(false); if (created) setSubmitted(true); }} />
        ) : !session ? (
          <button style={ghostBtn} onClick={() => setAuthOpen(true)}>Sign in to add your business</button>
        ) : canPost ? (
          <button style={primaryBtn} onClick={() => setComposing(true)}>Add your business</button>
        ) : (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>Listing is open to live Food to Go members.</p>
        )}
      </div>

      {error ? <p style={{ color: "var(--crimson-700)", fontSize: 14 }}>{error}</p> : null}

      {orgs === undefined ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14 }}>Loading…</p>
      ) : orgs.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14 }}>No suppliers listed yet.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {orgs.map((o) => (
            <Link key={o.id} href={`/suppliers/${o.slug}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-4)", display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
                {o.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={o.logoUrl} alt="" width={44} height={44} style={{ borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                ) : null}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15.5, color: "var(--ink)" }}>{o.name}</div>
                  <div style={{ marginTop: 2, fontSize: 13, color: "var(--ink-2)" }}>
                    {[o.category, o.locality].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
        intro="Sign in to list your business on Food to Go."
      />
    </main>
  );
}

function SupplierComposer({ onDone }: { onDone: (created: boolean) => void }) {
  const trpc = useTrpc();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [website, setWebsite] = useState("");
  const [locality, setLocality] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (name.trim().length < 2) { setErr("A business name is required."); return; }
    setBusy(true);
    const mut = trpc.suppliers.create as unknown as { mutate: (i: Record<string, unknown>) => Promise<{ id: string | null }> };
    try {
      await mut.mutate({
        name: name.trim(),
        description: description.trim() || undefined,
        category: category.trim() || undefined,
        website: website.trim() || undefined,
        locality: locality.trim() || undefined,
      });
      onDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to submit.");
      setBusy(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-4)", display: "grid", gap: "var(--space-3)", background: "var(--paper)" }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>Add your business</div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", margin: 0 }}>Submitted for review before it appears in the directory.</p>
      <input style={inputStyle} placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      <textarea style={{ ...inputStyle, minHeight: 80, resize: "vertical" }} placeholder="What you supply (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, flex: 1, minWidth: 150 }} placeholder="Category (optional)" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
        <input style={{ ...inputStyle, flex: 1, minWidth: 150 }} placeholder="Town (optional)" value={locality} onChange={(e) => setLocality(e.target.value)} maxLength={120} />
      </div>
      <input style={inputStyle} placeholder="Website (optional, https://…)" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={2000} />
      {err ? <p style={{ color: "var(--crimson-700)", fontSize: 13, margin: 0 }}>{err}</p> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button style={primaryBtn} onClick={() => void submit()} disabled={busy}>{busy ? "Submitting…" : "Submit for review"}</button>
        <button style={ghostBtn} onClick={() => onDone(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

const pageWrap: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "var(--space-6) var(--space-4)" };
const inputStyle: React.CSSProperties = { boxSizing: "border-box", width: "100%", padding: "10px 12px", background: "#fff", border: "1px solid var(--line)", borderRadius: 8, fontFamily: "var(--ui)", fontSize: 14, color: "var(--ink)", outline: "none" };
const primaryBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", background: "var(--crimson)", color: "#fff", borderRadius: 999, fontWeight: 600, fontSize: 14, textAlign: "center" };
const ghostBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 999, fontWeight: 600, fontSize: 14, textAlign: "center" };
