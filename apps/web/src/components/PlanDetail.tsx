/**
 * PlanDetail — /plans/[planId]: a plan's venues, with inline edit (title · date · notes) and
 * remove-venue / delete-plan. Private (protected); RLS enforces owner/member access, so an
 * out-of-scope plan resolves to "not found". v1 is owner-centric (group invites come later).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { CopyLinkButton } from "./CopyLinkButton";
import { venuePath } from "../lib/routes";
import { CATEGORY_GROUPS, useCategoryLabel } from "../lib/categories";
import { planDateLabel, planDateInput } from "../lib/planDate";
import { uploadProfileImage } from "../lib/uploadProfileImage";
import { ImageCropper } from "./ImageCropper";

/** A calm crimson gradient used when a plan has no custom header image. */
const PLAN_GRADIENT = "linear-gradient(135deg, var(--crimson) 0%, var(--crimson-700) 55%, #7a0c28 100%)";

interface PlanVenue {
  venueId: string;
  name: string;
  category: string | null;
}
/** A "you might add" suggestion (plans.suggestions) — a light venue card for the strip. */
interface Suggestion {
  venueId: string;
  name: string;
  category: string | null;
  primaryTypeLabel: string | null;
  rating: number | null;
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

function personName(t: ReturnType<typeof useTranslations>, p: { displayName: string | null; handle: string | null }): string {
  if (p.displayName && p.displayName.trim()) return p.displayName.trim();
  if (p.handle && p.handle.trim()) return `@${p.handle.trim()}`;
  return t("roamMember");
}

/** The teaser a shared link shows a non-member (plans.preview): counts only, no names/notes. */
export interface PlanPreview {
  id: string;
  title: string;
  plannedFor: string | null;
  headerUrl: string | null;
  memberCount: number;
  venueCount: number;
}

export function PlanDetail({ planId, preview }: { planId: string; preview?: PlanPreview | null }) {
  const t = useTranslations("planDetail");
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
        if (!cancelled) setError(e instanceof Error ? e.message : t("errors.load"));
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

  // Venue suggestions — nearby venues to add, anchored on the plan's current venues (0082).
  // Loaded once the plan has >=1 venue (an empty plan has no anchor). Keyed on hasVenues (a
  // boolean), so adding more venues doesn't re-fetch — the optimistic filter in addSuggestion
  // keeps the strip in sync without a race against the server commit.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const hasVenues = (plan?.venues.length ?? 0) > 0;
  useEffect(() => {
    if (!hasSession || !hasVenues) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    // Fetch a broader set (up to the RPC's cap) so the category chips below have real substance —
    // one chip per canonical category that actually has a nearby suggestion. The "All" view still
    // shows just the nearest few; a chip reveals that category's nearby venues.
    const sug = trpc.plans.suggestions as unknown as { query: (i: { planId: string; limit: number }) => Promise<{ venues: Suggestion[] }> };
    sug
      .query({ planId, limit: 20 })
      .then((res) => {
        if (!cancelled) setSuggestions(res.venues ?? []);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, planId, hasSession, hasVenues]);

  // Category filter for the suggestions strip (chips, like Explore). null = "All". Only categories
  // that actually appear among the nearby suggestions get a chip; when the active one empties out
  // (e.g. its last venue was added), fall back to "All" so the strip never looks broken.
  const categoryLabel = useCategoryLabel();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  useEffect(() => {
    if (activeCategory && !suggestions.some((s) => s.category === activeCategory)) {
      setActiveCategory(null);
    }
  }, [suggestions, activeCategory]);

  const addSuggestion = useCallback(
    async (s: Suggestion) => {
      const mut = trpc.plans.addVenue as unknown as { mutate: (i: { planId: string; venueId: string }) => Promise<unknown> };
      // Optimistic: drop it from the strip and append it to the plan's venues.
      setSuggestions((list) => list.filter((x) => x.venueId !== s.venueId));
      setPlan((p) =>
        p && !p.venues.some((v) => v.venueId === s.venueId)
          ? { ...p, venues: [...p.venues, { venueId: s.venueId, name: s.name, category: s.category }] }
          : p,
      );
      try {
        await mut.mutate({ planId, venueId: s.venueId });
      } catch {
        // Add failed: reconcile the plan from the server AND put the suggestion back on the
        // strip (reload() only refetches the plan, not suggestions, and hasVenues is unchanged
        // so the suggestions effect won't re-run — without this the venue vanishes for good).
        setSuggestions((list) => (list.some((x) => x.venueId === s.venueId) ? list : [s, ...list]));
        reload();
      }
    },
    [trpc, planId, reload],
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
        <span aria-hidden>←</span> {t("back")}
      </Link>

      {!hasSession ? (
        <PlanTeaser preview={preview ?? null}>
          <AuthPanel
            intro={t("signedOutIntro")}
            emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
            onAuthed={() => {}}
          />
        </PlanTeaser>
      ) : error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : plan === undefined ? (
        <div style={{ height: 200, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : plan === null && preview ? (
        // Signed in but not a member: RLS hid the plan but the teaser exists (this is a shared
        // link). Show it with the way in — membership is invite-only, so point at the sharer.
        <PlanTeaser preview={preview}>
          <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.55 }}>
            {t.rich("notMemberBody", {
              plansLink: (chunks) => <Link href="/plans" style={{ color: "var(--crimson-700)" }}>{chunks}</Link>,
            })}
          </p>
        </PlanTeaser>
      ) : plan === null ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>{t("notFound.title")}</div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>{t("notFound.body")}</p>
        </Card>
      ) : editing ? (
        <PlanEditor plan={plan} onSaved={() => { setEditing(false); reload(); }} onCancel={() => setEditing(false)} onDelete={() => void deletePlan()} />
      ) : (
        <>
          <PlanBanner plan={plan} />

          <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button variant="pri" size="sm" onClick={() => void openChat()} disabled={openingChat}>
              {openingChat ? t("opening") : <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="chat" size={14} /> {t("groupChat")}</span>}
            </Button>
            <CopyLinkButton variant="button" size="sm" title={plan.title} />
            <Button variant="neutral" size="sm" onClick={() => setEditing(true)}>{t("edit")}</Button>
          </div>

          {plan.notes ? <p style={{ marginTop: "var(--space-3)", color: "var(--ink-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{plan.notes}</p> : null}

          <PlanMembers planId={plan.id} />

          <div style={{ marginTop: "var(--space-5)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
            {t("venues", { count: plan.venues.length })}
          </div>

          {plan.venues.length === 0 ? (
            <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
              <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
                {t.rich("emptyVenues", { strong: (chunks) => <strong>{chunks}</strong> })}
              </p>
              <div style={{ marginTop: "var(--space-3)" }}>
                <Link href="/explore" style={{ textDecoration: "none" }}><Button variant="neutral" size="sm">{t("findVenues")}</Button></Link>
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
                    <button type="button" onClick={() => void removeVenue(v.venueId)} title={t("removeFromPlanTitle")} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 12, textDecoration: "underline", flexShrink: 0 }}>
                      {t("remove")}
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {suggestions.length > 0 ? (() => {
            const available = CATEGORY_GROUPS.filter((c) => suggestions.some((s) => s.category === c));
            const visible = activeCategory ? suggestions.filter((s) => s.category === activeCategory) : suggestions.slice(0, 6);
            return (
            <section style={{ marginTop: "var(--space-6)" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
                {t("suggestions.title")}
              </div>
              <p style={{ margin: "4px 0 var(--space-3)", fontSize: 13, color: "var(--ink-2)" }}>{t("suggestions.hint")}</p>
              {available.length >= 2 ? (
                <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6, marginBottom: "var(--space-2)", scrollbarWidth: "none" }}>
                  <SuggestChip label={t("suggestions.all")} active={activeCategory === null} onClick={() => setActiveCategory(null)} />
                  {available.map((c) => (
                    <SuggestChip key={c} label={categoryLabel(c)} active={activeCategory === c} onClick={() => setActiveCategory(c)} />
                  ))}
                </div>
              ) : null}
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {visible.map((s) => (
                  <Card key={s.venueId} style={{ padding: "var(--space-3) var(--space-4)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <Link href={venuePath(s.venueId)} style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
                        {s.primaryTypeLabel || s.category ? (
                          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{s.primaryTypeLabel || s.category}</div>
                        ) : null}
                      </Link>
                      <Button variant="pri" size="sm" onClick={() => void addSuggestion(s)}>
                        {t("suggestions.add")}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
            );
          })() : null}
        </>
      )}
    </main>
  );
}

/** A pill filter chip for the suggestions strip — crimson-filled when active (mirrors Explore). */
function SuggestChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        all: "unset",
        cursor: "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
        padding: "5px 12px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 600,
        border: active ? "1px solid var(--crimson-700)" : "1px solid var(--line)",
        background: active ? "var(--crimson-700)" : "var(--paper-2)",
        color: active ? "#fff" : "var(--ink-2)",
      }}
    >
      {label}
    </button>
  );
}

/**
 * PlanBanner — the plan's hero. A custom header image (cover) or a calm crimson gradient when
 * none is set, with the title + date overlaid on a dark scrim. Designed to read like a card —
 * it's the part that shines on mobile/native.
 */
function PlanBanner({ plan }: { plan: { title: string; plannedFor: string | null; headerUrl: string | null } }) {
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

/**
 * The non-member view of a shared plan link: the banner (title, date, header image), the teaser
 * counts, and — as children — the way in (sign-in panel for visitors, an invite note for
 * signed-in non-members). When the preview couldn't load, just the children in a card.
 */
function PlanTeaser({ preview, children }: { preview: PlanPreview | null; children: React.ReactNode }) {
  const t = useTranslations("planDetail");
  if (!preview) {
    return <Card style={{ padding: "var(--space-4)" }}>{children}</Card>;
  }
  const bits = [
    preview.venueCount > 0 ? t("places", { count: preview.venueCount }) : null,
    preview.memberCount > 0 ? t("going", { count: preview.memberCount }) : null,
  ].filter(Boolean);
  return (
    <>
      <PlanBanner plan={preview} />
      {bits.length > 0 ? (
        <div style={{ marginTop: "var(--space-3)", display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, color: "var(--ink-2)" }}>
          <Icon name="users" size={15} />
          {bits.join(" · ")}
        </div>
      ) : null}
      <Card style={{ padding: "var(--space-4)", marginTop: "var(--space-4)" }}>{children}</Card>
    </>
  );
}

function PlanEditor({ plan, onSaved, onCancel, onDelete }: { plan: Plan; onSaved: () => void; onCancel: () => void; onDelete: () => void }) {
  const t = useTranslations("planDetail");
  const trpc = useTrpc();
  const session = useSession();
  const [title, setTitle] = useState(plan.title);
  const [date, setDate] = useState(planDateInput(plan.plannedFor));
  const [notes, setNotes] = useState(plan.notes ?? "");
  const [headerUrl, setHeaderUrl] = useState<string | null>(plan.headerUrl);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [cropFile, setCropFile] = useState<File | null>(null);

  const onPickHeader = useCallback(
    (file: File | null) => {
      if (!file) return;
      if (!session?.user?.id) {
        setErr(t("errors.signInImage"));
        return;
      }
      setErr(null);
      setCropFile(file); // -> ImageCropper -> uploadCropped
    },
    [session],
  );

  const uploadCropped = useCallback(
    async (file: File) => {
      const uid = session?.user?.id;
      setCropFile(null);
      if (!uid) return;
      setUploading(true);
      setErr(null);
      try {
        const { url } = await uploadProfileImage(uid, file, "plan-header");
        setHeaderUrl(url);
      } catch (e) {
        setErr(e instanceof Error ? e.message : t("errors.upload"));
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
      setErr(e instanceof Error ? e.message : t("errors.save"));
      setBusy(false);
    }
  }, [trpc, plan.id, title, date, notes, headerUrl, onSaved]);

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      {/* Header image picker — the whole banner is clickable (ref-based, like ProfileEditor),
          with explicit Change / Remove controls below. A hidden input we trigger by ref is more
          reliable than a label-wrapped input across browsers. */}
      <div style={{ marginBottom: "var(--space-3)" }}>
        <div
          role="button"
          tabIndex={0}
          aria-label={headerUrl ? t("changeHeaderAria") : t("addHeaderAria")}
          onClick={() => { if (!uploading) fileRef.current?.click(); }}
          onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !uploading) fileRef.current?.click(); }}
          style={{
            position: "relative", height: 132, borderRadius: "var(--r-lg)", overflow: "hidden",
            background: headerUrl ? "var(--paper-2)" : PLAN_GRADIENT, border: "1px solid var(--line)",
            display: "flex", alignItems: "flex-end", cursor: uploading ? "default" : "pointer",
          }}
        >
          {headerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
            <img src={headerUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          ) : null}
          <span
            style={{
              position: "absolute", right: 8, bottom: 8, padding: "4px 10px", borderRadius: 999,
              fontSize: 11.5, fontWeight: 600, color: "#fff", background: "rgba(33,29,26,.72)",
            }}
          >
            {uploading ? t("uploading") : headerUrl ? t("change") : t("addImage")}
          </span>
          {!headerUrl ? (
            <span style={{ position: "relative", padding: "var(--space-3)", color: "rgba(255,255,255,.9)", fontSize: 12.5, fontFamily: "var(--ui)" }}>
              {t("tapToAddHeader")}
            </span>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; e.currentTarget.value = ""; onPickHeader(f); }}
        />
        {cropFile ? (
          <ImageCropper
            file={cropFile}
            spec={{ aspect: 3, outputWidth: 2000, title: t("cropTitle") }}
            onCancel={() => setCropFile(null)}
            onCropped={(f) => void uploadCropped(f)}
          />
        ) : null}
        {headerUrl ? (
          <div style={{ marginTop: "var(--space-2)" }}>
            <button type="button" onClick={() => setHeaderUrl(null)} disabled={uploading} style={{ all: "unset", cursor: "pointer", fontSize: 13, color: "var(--muted)", textDecoration: "underline" }}>
              {t("removeImage")}
            </button>
          </div>
        ) : null}
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t("planTitleAria")} maxLength={120} style={editInput} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("plannedDateAria")} style={editInput} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={t("notesAria")} rows={3} placeholder={t("notesPlaceholder")} style={{ ...editInput, resize: "vertical", minHeight: 72 }} />
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void save()} disabled={title.trim().length === 0 || busy || uploading}>{busy ? t("saving") : t("save")}</Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>{t("cancel")}</Button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onDelete} style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 13, textDecoration: "underline" }}>
          {t("deletePlan")}
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
  const t = useTranslations("planDetail");
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
    return <div style={{ marginTop: "var(--space-6)", height: 40, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />;
  }

  const memberIds = new Set(members.map((m) => m.profileId));
  const invitable = friends.filter((f) => !memberIds.has(f.id));

  return (
    <section style={{ marginTop: "var(--space-6)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
          {t("members", { count: members.length })}
        </div>
        {isOwner ? (
          <button
            type="button"
            onClick={() => (inviting ? setInviting(false) : void openInvite())}
            style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 13, fontWeight: 600 }}
          >
            {inviting ? t("done") : t("inviteFriends")}
          </button>
        ) : null}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
        {members.map((m) => (
          <div key={m.profileId} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px 5px 6px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)" }}>
            <MemberAvatar p={m} size={24} />
            <Link href={`/u/${m.handle ?? m.profileId}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>
              {personName(t, m)}
            </Link>
            {m.role === "owner" ? (
              <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".05em" }}>{t("host")}</span>
            ) : isOwner ? (
              <button
                type="button"
                onClick={() => void remove(m.profileId)}
                disabled={busyId === m.profileId}
                title={t("removeFromPlanTitle")}
                aria-label={t("removeMemberAria", { name: personName(t, m) })}
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
                ? t("noFriendsToInvite")
                : t("allFriendsOnPlan")}
            </p>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              {invitable.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <MemberAvatar p={{ displayName: f.displayName, handle: f.handle, avatarUrl: f.avatarUrl }} size={28} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{personName(t, f)}</span>
                  <Button variant="neutral" size="sm" onClick={() => void invite(f.id)} disabled={busyId === f.id}>
                    {busyId === f.id ? "…" : t("add")}
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
  const t = useTranslations("planDetail");
  if (p.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={p.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {personName(t, p).replace(/^@/, "").charAt(0).toUpperCase() || "·"}
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
