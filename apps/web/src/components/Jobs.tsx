/**
 * Jobs — the F2G employability board (C4-b). A channel-scoped list of local job posts with an inline
 * composer that's gated on live membership (the server enforces it via RLS; jobs.canPost pre-flights
 * the UI so a non-member sees why they can't post rather than a failed submit).
 *
 * v1 is post-and-apply-out: each card's only action is an outbound Apply link. No applicant data is
 * ever collected here — the board never sees an application.
 *
 * Mirrors the Events board (list + just-in-time auth + inline composer); channel comes from useChannel.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc, useSession } from "./TrpcProvider";
import { useChannel } from "./ChannelProvider";
import { AuthModal } from "./AuthModal";

// Mirror of @roam/core/jobs (the web bundle deliberately doesn't import core). Kept small + in step.
const EMPLOYMENT_TYPES = [
  "full_time", "part_time", "temporary", "apprenticeship", "seasonal", "casual", "internship", "other",
] as const;
type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  full_time: "Full-time", part_time: "Part-time", temporary: "Temporary", apprenticeship: "Apprenticeship",
  seasonal: "Seasonal", casual: "Casual", internship: "Internship", other: "Other",
};

interface JobPost {
  id: string;
  title: string;
  description: string | null;
  employmentType: string | null;
  locality: string;
  localityLabel: string;
  locationName: string | null;
  applyUrl: string;
  salaryText: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  venue: { name: string; slug: string } | null;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function Jobs() {
  const trpc = useTrpc();
  const session = useSession();
  const { key: channelKey, isEnabled } = useChannel();

  const [posts, setPosts] = useState<JobPost[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [canPost, setCanPost] = useState(false);
  const [composing, setComposing] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const load = useCallback(() => {
    const list = trpc.jobs.list as unknown as {
      query: (i: { channelKey: string }) => Promise<{ posts: JobPost[] }>;
    };
    list.query({ channelKey })
      .then((r) => setPosts(r.posts))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load jobs."));
  }, [trpc, channelKey]);

  useEffect(() => { load(); }, [load]);

  // Pre-flight: may the signed-in user post here (a live member)?
  useEffect(() => {
    if (!session) { setCanPost(false); return; }
    let cancelled = false;
    const q = trpc.jobs.canPost as unknown as { query: (i: { channelKey: string }) => Promise<{ canPost: boolean }> };
    q.query({ channelKey }).then((r) => { if (!cancelled) setCanPost(r.canPost); }).catch(() => {});
    return () => { cancelled = true; };
  }, [trpc, session, channelKey]);

  // The board is a Food to Go surface; if the active channel doesn't expose it, say so gently.
  if (!isEnabled("jobs")) {
    return (
      <main style={pageWrap}>
        <p style={{ color: "var(--ink-2)", fontSize: 15 }}>The jobs board isn't available here yet.</p>
      </main>
    );
  }

  return (
    <main style={pageWrap}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          Local jobs
        </div>
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 32, letterSpacing: "-.02em", margin: 0 }}>Work near you</h1>
        <p style={{ color: "var(--ink-2)", margin: "6px 0 0", fontSize: 14.5, lineHeight: 1.5 }}>
          Jobs from local Food to Go members. Applying takes you to each employer directly.
        </p>
      </header>

      {/* Post-a-job entry: live members get the composer; signed-out visitors are prompted to sign in. */}
      <div style={{ marginBottom: "var(--space-5)" }}>
        {composing ? (
          <JobComposer
            channelKey={channelKey}
            onDone={(created) => { setComposing(false); if (created) load(); }}
          />
        ) : !session ? (
          <button style={ghostBtn} onClick={() => setAuthOpen(true)}>Sign in to post a job</button>
        ) : canPost ? (
          <button style={primaryBtn} onClick={() => setComposing(true)}>Post a job</button>
        ) : (
          <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
            Posting is open to live Food to Go members.
          </p>
        )}
      </div>

      {error ? <p style={{ color: "var(--crimson-700)", fontSize: 14 }}>{error}</p> : null}

      {posts === undefined ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14 }}>Loading…</p>
      ) : posts.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14 }}>No jobs posted yet — check back soon.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {posts.map((p) => <JobRow key={p.id} post={p} />)}
        </div>
      )}

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
        intro="Sign in to post a job on Food to Go."
      />
    </main>
  );
}

function JobRow({ post }: { post: JobPost }) {
  const typeLabel = post.employmentType && post.employmentType in EMPLOYMENT_LABEL
    ? EMPLOYMENT_LABEL[post.employmentType as EmploymentType]
    : null;
  const meta = [typeLabel, post.venue?.name ?? post.locationName, post.localityLabel, post.salaryText]
    .filter(Boolean)
    .join(" · ");
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-4)", display: "flex", gap: "var(--space-3)", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15.5, color: "var(--ink)" }}>{post.title}</div>
        {meta ? <div style={{ marginTop: 3, fontSize: 13, color: "var(--ink-2)" }}>{meta}</div> : null}
        {post.description ? (
          <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{post.description}</p>
        ) : null}
      </div>
      <a href={post.applyUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ ...primaryBtn, textDecoration: "none", flexShrink: 0 }}>
        Apply <span aria-hidden>↗</span>
      </a>
    </div>
  );
}

/* ── Composer ────────────────────────────────────────────────────────────────────────────── */

function JobComposer({ channelKey, onDone }: { channelKey: string; onDone: (created: boolean) => void }) {
  const trpc = useTrpc();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [employmentType, setEmploymentType] = useState<EmploymentType | "">("");
  const [town, setTown] = useState("");
  const [applyUrl, setApplyUrl] = useState("");
  const [salaryText, setSalaryText] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!title.trim() || !town.trim() || !applyUrl.trim()) {
      setErr("Title, town and an apply link are required.");
      return;
    }
    setBusy(true);
    const mut = trpc.jobs.create as unknown as {
      mutate: (i: Record<string, unknown>) => Promise<{ id: string | null }>;
    };
    try {
      await mut.mutate({
        channelKey,
        title: title.trim(),
        description: description.trim() || undefined,
        employmentType: employmentType || undefined,
        locality: slugify(town),
        localityLabel: town.trim(),
        applyUrl: applyUrl.trim(),
        salaryText: salaryText.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      onDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to post the job.");
      setBusy(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-4)", display: "grid", gap: "var(--space-3)", background: "var(--paper)" }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: "var(--ink)" }}>Post a job</div>
      <input style={inputStyle} placeholder="Job title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
      <textarea style={{ ...inputStyle, minHeight: 90, resize: "vertical" }} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} />
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <select style={{ ...inputStyle, flex: 1, minWidth: 150 }} value={employmentType} onChange={(e) => setEmploymentType(e.target.value as EmploymentType | "")}>
          <option value="">Type (optional)</option>
          {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_LABEL[t]}</option>)}
        </select>
        <input style={{ ...inputStyle, flex: 1, minWidth: 150 }} placeholder="Town" value={town} onChange={(e) => setTown(e.target.value)} maxLength={120} />
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, flex: 1, minWidth: 150 }} placeholder="Pay (optional, e.g. £11.50/hr)" value={salaryText} onChange={(e) => setSalaryText(e.target.value)} maxLength={120} />
        <input style={{ ...inputStyle, flex: 1, minWidth: 150 }} type="date" aria-label="Closes on (optional)" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </div>
      <input style={inputStyle} placeholder="Apply link (https://…)" value={applyUrl} onChange={(e) => setApplyUrl(e.target.value)} maxLength={2000} />
      {err ? <p style={{ color: "var(--crimson-700)", fontSize: 13, margin: 0 }}>{err}</p> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button style={primaryBtn} onClick={() => void submit()} disabled={busy}>{busy ? "Posting…" : "Post job"}</button>
        <button style={ghostBtn} onClick={() => onDone(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

const pageWrap: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "var(--space-6) var(--space-4)" };
const inputStyle: React.CSSProperties = { boxSizing: "border-box", width: "100%", padding: "10px 12px", background: "#fff", border: "1px solid var(--line)", borderRadius: 8, fontFamily: "var(--ui)", fontSize: 14, color: "var(--ink)", outline: "none" };
const primaryBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", background: "var(--crimson)", color: "#fff", borderRadius: 999, fontWeight: 600, fontSize: 14, textAlign: "center" };
const ghostBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 999, fontWeight: 600, fontSize: 14, textAlign: "center" };
