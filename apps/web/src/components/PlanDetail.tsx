/**
 * PlanDetail — /plans/[planId]: a plan's venues, with inline edit (title · date · notes) and
 * remove-venue / delete-plan. Private (protected); RLS enforces owner/member access, so an
 * out-of-scope plan resolves to "not found". v1 is owner-centric (group invites come later).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { venuePath } from "../lib/routes";
import { planDateLabel, planDateInput } from "../lib/planDate";
import { uploadProfileImage } from "../lib/uploadProfileImage";

/** A calm crimson gradient used when a plan has no custom header image. */
const PLAN_GRADIENT = "linear-gradient(135deg, var(--crimson) 0%, var(--crimson-700) 55%, #7a0c28 100%)";

interface PlanVenue {
  venueId: string;
  name: string;
  category: string | null;
}
interface Plan {
  id: string;
  title: string;
  notes: string | null;
  plannedFor: string | null;
  headerUrl: string | null;
  venues: PlanVenue[];
}
interface PlanMember {
  profileId: string;
  role: "owner" | "member";
  accepted: boolean;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}
interface Friend {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function personName(p: { displayName: string | null; handle: string | null }): string {
  if (p.displayName && p.displayName.trim()) return p.displayName.trim();
  if (p.handle && p.handle.trim()) return `@${p.handle.trim()}`;
  return "Roam member";
}

export function PlanDetail({ planId }: { planId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const router = useRouter();
  const hasSession = !!session;
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const byId = trpc.plans.byId as unknown as { query: (i: { planId: string }) => Promise<Plan | null> };
    return byId.query({ planId });
  }, [trpc, planId]);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    setPlan(undefined);
    setError(null);
    load()
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this plan.");
      });
    return () => {
      cancelled = true;
    };
  }, [hasSession, load]);

  const reload = useCallback(() => {
    void load().then((p) => setPlan(p)).catch(() => {});
  }, [load]);

  const removeVenue = useCallback(
    async (venueId: string) => {
      const mut = trpc.plans.removeVenue as unknown as { mutate: (i: { planId: string; venueId: string }) => Promise<unknown> };
      try {
        await mut.mutate({ planId, venueId });
        setPlan((p) => (p ? { ...p, venues: p.venues.filter((v) => v.venueId !== venueId) } : p));
      } catch {
        /* leave as-is on failure */
      }
    },
    [trpc, planId],
  );

  const deletePlan = useCallback(async () => {
    const mut = trpc.plans.remove as unknown as { mutate: (i: { planId: string }) => Promise<unknown> };
    try {
      await mut.mutate({ planId });
      router.push("/plans");
    } catch {
      /* no-op */
    }
  }, [trpc, planId, router]);

  const [openingChat, setOpeningChat] = useState(false);
  const openChat = useCallback(async () => {
    setOpeningChat(true);
    const mut = trpc.plans.chat as unknown as { mutate: (i: { planId: string }) => Promise<{ threadId: string }> };
    try {
      const { threadId } = await mut.mutate({ planId });
      router.push(`/threads/${threadId}`);
    } catch {
      setOpeningChat(false);
    }
  }, [trpc, planId, router]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/plans"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> Plans
      </Link>

      {!hasSession ? (
        <Card style={{ padding: "var(--space-4)" }}>
          <AuthPanel intro="Sign in to view this plan." emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""} onAuthed={() => {}} />
        </Card>
      ) : error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : plan === undefined ? (
        <div style={{ height: 200, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : plan === null ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>Plan not found</div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>It may have been removed, or you don&apos;t have access.</p>
        </Card>
      ) : editing ? (
        <PlanEditor plan={plan} onSaved={() => { setEditing(false); reload(); }} onCancel={() => setEditing(false)} onDelete={() => void deletePlan()} />
      ) : (
        <>
          <PlanBanner plan={plan} />

          <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button variant="pri" size="sm" onClick={() => void openChat()} disabled={openingChat}>
              {openingChat ? "Opening…" : "💬 Group chat"}
            </Button>
            <Button variant="neutral" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          </div>

          {plan.notes ? <p style={{ marginTop: "var(--space-3)", color: "var(--ink-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{plan.notes}</p> : null}

          <PlanMembers planId={plan.id} />

          <div style={{ marginTop: "var(--space-5)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
            {plan.venues.length === 1 ? "1 venue" : `${plan.venues.length} venues`}
          </div>

          {plan.venues.length === 0 ? (
            <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
              <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
                No venues yet. Open any venue and tap <strong>＋ Add to Plan</strong> to add it here.
              </p>
              <div style={{ marginTop: "var(--space-3)" }}>
                <Link href="/explore" style={{ textDecoration: "none" }}><Button variant="neutral" size="sm">Find venues</Button></Link>
              </div>
            </Card>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {plan.venues.map((v) => (
                <Card key={v.venueId} style={{ padding: "var(--space-3) var(--space-4)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <Link href={venuePath(v.venueId)} style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</div>
                      {v.category ? <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{v.category}</div> : null}
                    </Link>
                    <button type="button" onClick={() => void removeVenue(v.venueId)} title="Remove from plan" style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 12, textDecoration: "underline", flexShrink: 0 }}>
                      Remove
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

/**
 * PlanBanner — the plan's hero. A custom header image (cover) or a calm crimson gradient when
 * none is set, with the title + date overlaid on a dark scrim. Designed to read like a card —
 * it's the part that shines on mobile/native.
 */
function PlanBanner({ plan }: { plan: Plan }) {
  return (
    <div
      style={{
        position: "relative",
        borderRadius: "var(--r-lg)",
        overflow: "hidden",
        minHeight: 168,
        display: "flex",
        alignItems: "flex-end",
        background: plan.headerUrl ? "var(--paper-2)" : PLAN_GRADIENT,
        border: "1px solid var(--line)",
      }}
    >
      {plan.headerUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- public bucket URL; next/image adds no value here
        <img
          src={plan.headerUrl}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
      {/* Scrim so the title stays legible over any image. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to top, rgba(0,0,0,.58) 0%, rgba(0,0,0,.12) 45%, rgba(0,0,0,0) 75%)",
        }}
      />
      <div style={{ position: "relative", padding: "var(--space-4)", width: "100%" }}>
        {plan.plannedFor ? (
          <span
            style={{
              display: "inline-block",
              marginBottom: 8,
              fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase",
              color: "#fff", background: "rgba(255,255,255,.18)", backdropFilter: "blur(4px)",
              borderRadius: 999, padding: "3px 10px",
            }}
          >
            {planDateLabel(plan.plannedFor)}
          </span>
        ) : null}
        <h1
          className="t-h1"
          style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0, color: "#fff", textShadow: "0 1px 14px rgba(0,0,0,.35)" }}
        >
          {plan.title}
        </h1>
      </div>
    </div>
  );
}

function PlanEditor({ plan, onSaved, onCancel, onDelete }: { plan: Plan; onSaved: () => void; onCancel: () => void; onDelete: () => void }) {
  const trpc = useTrpc();
  const session = useSession();
  const [title, setTitle] = useState(plan.title);
  const [date, setDate] = useState(planDateInput(plan.plannedFor));
  const [notes, setNotes] = useState(plan.notes ?? "");
  const [headerUrl, setHeaderUrl] = useState<string | null>(plan.headerUrl);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onPickHeader = useCallback(
    async (file: File | null) => {
      const uid = session?.user?.id;
      if (!file || !uid) return;
      setUploading(true);
      setErr(null);
      try {
        const { url } = await uploadProfileImage(uid, file, "plan-header");
        setHeaderUrl(url);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't upload that image.");
      } finally {
        setUploading(false);
      }
    },
    [session],
  );

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const update = trpc.plans.update as unknown as {
      mutate: (i: { planId: string; title: string; notes: string | null; plannedFor: string | null; headerUrl: string | null }) => Promise<{ ok: true }>;
    };
    try {
      const plannedFor = date ? new Date(`${date}T12:00:00`).toISOString() : null;
      await update.mutate({ planId: plan.id, title, notes: notes.trim() ? notes : null, plannedFor, headerUrl });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save the plan.");
      setBusy(false);
    }
  }, [trpc, plan.id, title, date, notes, headerUrl, onSaved]);

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      {/* Header image picker — preview (image or gradient) + change / remove. */}
      <div style={{ marginBottom: "var(--space-3)" }}>
        <div
          style={{
            position: "relative", height: 132, borderRadius: "var(--r-lg)", overflow: "hidden",
            background: headerUrl ? "var(--paper-2)" : PLAN_GRADIENT, border: "1px solid var(--line)",
            display: "flex", alignItems: "flex-end",
          }}
        >
          {headerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
            <img src={headerUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ position: "relative", padding: "var(--space-3)", color: "rgba(255,255,255,.85)", fontSize: 12.5, fontFamily: "var(--ui)" }}>
              No header image yet
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          <label style={{ cursor: uploading ? "default" : "pointer" }}>
            <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} disabled={uploading} onChange={(e) => void onPickHeader(e.target.files?.[0] ?? null)} />
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--crimson-700)" }}>
              {uploading ? "Uploading…" : headerUrl ? "Change image" : "＋ Add header image"}
            </span>
          </label>
          {headerUrl ? (
            <>
              <span aria-hidden style={{ color: "var(--faint)" }}>·</span>
              <button type="button" onClick={() => setHeaderUrl(null)} disabled={uploading} style={{ all: "unset", cursor: "pointer", fontSize: 13, color: "var(--muted)", textDecoration: "underline" }}>
                Remove
              </button>
            </>
          ) : null}
        </div>
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Plan title" maxLength={120} style={editInput} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Planned date" style={editInput} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" rows={3} placeholder="Notes (optional)" style={{ ...editInput, resize: "vertical", minHeight: 72 }} />
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void save()} disabled={title.trim().length === 0 || busy || uploading}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>Cancel</Button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onDelete} style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 13, textDecoration: "underline" }}>
          Delete plan
        </button>
      </div>
    </Card>
  );
}

/**
 * PlanMembers — the people on a plan: the owner plus invited friends. The owner can invite from
 * their friends list and remove members; everyone shares the plan and its group chat. Loads
 * plans.members; the invite picker loads social.myFriends and hides anyone already on the plan.
 */
function PlanMembers({ planId }: { planId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const me = session?.user?.id ?? null;
  const [members, setMembers] = useState<PlanMember[] | undefined>(undefined);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    const q = trpc.plans.members as unknown as { query: (i: { planId: string }) => Promise<{ members: PlanMember[] }> };
    const res = await q.query({ planId });
    return res.members ?? [];
  }, [trpc, planId]);

  useEffect(() => {
    let cancelled = false;
    loadMembers()
      .then((m) => { if (!cancelled) setMembers(m); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [loadMembers]);

  const isOwner = !!me && !!members?.some((m) => m.role === "owner" && m.profileId === me);

  const openInvite = useCallback(async () => {
    setInviting(true);
    const q = trpc.social.myFriends as unknown as { query: () => Promise<{ ok: boolean; friends?: Friend[] }> };
    try {
      const r = await q.query();
      setFriends(r.ok ? r.friends ?? [] : []);
    } catch {
      setFriends([]);
    }
  }, [trpc]);

  const invite = useCallback(async (friendId: string) => {
    setBusyId(friendId);
    const m = trpc.plans.invite as unknown as { mutate: (i: { planId: string; profileId: string }) => Promise<unknown> };
    try {
      await m.mutate({ planId, profileId: friendId });
      setMembers(await loadMembers());
    } catch {
      /* no-op */
    } finally {
      setBusyId(null);
    }
  }, [trpc, planId, loadMembers]);

  const remove = useCallback(async (profileId: string) => {
    setBusyId(profileId);
    const m = trpc.plans.removeMember as unknown as { mutate: (i: { planId: string; profileId: string }) => Promise<unknown> };
    try {
      await m.mutate({ planId, profileId });
      setMembers((prev) => (prev ? prev.filter((x) => x.profileId !== profileId) : prev));
    } catch {
      /* no-op */
    } finally {
      setBusyId(null);
    }
  }, [trpc, planId]);

  if (members === undefined) {
    return <div style={{ marginTop: "var(--space-5)", height: 40, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />;
  }

  const memberIds = new Set(members.map((m) => m.profileId));
  const invitable = friends.filter((f) => !memberIds.has(f.id));

  return (
    <section style={{ marginTop: "var(--space-5)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
          {members.length === 1 ? "Just you" : `${members.length} people`}
        </div>
        {isOwner ? (
          <button
            type="button"
            onClick={() => (inviting ? setInviting(false) : void openInvite())}
            style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 13, fontWeight: 600 }}
          >
            {inviting ? "Done" : "＋ Invite friends"}
          </button>
        ) : null}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        {members.map((m) => (
          <div key={m.profileId} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px 5px 6px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)" }}>
            <MemberAvatar p={m} size={24} />
            <Link href={`/u/${m.profileId}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>
              {personName(m)}
            </Link>
            {m.role === "owner" ? (
              <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".05em" }}>host</span>
            ) : isOwner ? (
              <button
                type="button"
                onClick={() => void remove(m.profileId)}
                disabled={busyId === m.profileId}
                title="Remove from plan"
                aria-label={`Remove ${personName(m)} from plan`}
                style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 14, lineHeight: 1, padding: "0 2px" }}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {isOwner && inviting ? (
        <Card flat style={{ marginTop: "var(--space-3)", padding: "var(--space-3) var(--space-4)" }}>
          {invitable.length === 0 ? (
            <p style={{ color: "var(--ink-2)", margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              {friends.length === 0
                ? "No friends to invite yet. Add friends from their profile walls, then invite them here."
                : "All your friends are already on this plan."}
            </p>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {invitable.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <MemberAvatar p={{ displayName: f.displayName, handle: f.handle, avatarUrl: f.avatarUrl }} size={28} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{personName(f)}</span>
                  <Button variant="neutral" size="sm" onClick={() => void invite(f.id)} disabled={busyId === f.id}>
                    {busyId === f.id ? "…" : "Add"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </section>
  );
}

function MemberAvatar({ p, size }: { p: { displayName: string | null; handle: string | null; avatarUrl: string | null }; size: number }) {
  if (p.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={p.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {personName(p).replace(/^@/, "").charAt(0).toUpperCase() || "·"}
    </span>
  );
}

const editInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginBottom: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16,
  color: "var(--ink)",
  outline: "none",
};
