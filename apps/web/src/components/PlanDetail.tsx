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
  venues: PlanVenue[];
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
          <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)" }}>
            <div style={{ minWidth: 0 }}>
              <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, letterSpacing: "-.02em", margin: 0 }}>{plan.title}</h1>
              {plan.plannedFor ? <div style={{ marginTop: 4, fontSize: 13, color: "var(--crimson-700)", fontWeight: 600 }}>{planDateLabel(plan.plannedFor)}</div> : null}
            </div>
            <Button variant="neutral" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          </header>

          {plan.notes ? <p style={{ marginTop: "var(--space-3)", color: "var(--ink-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{plan.notes}</p> : null}

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

function PlanEditor({ plan, onSaved, onCancel, onDelete }: { plan: Plan; onSaved: () => void; onCancel: () => void; onDelete: () => void }) {
  const trpc = useTrpc();
  const [title, setTitle] = useState(plan.title);
  const [date, setDate] = useState(planDateInput(plan.plannedFor));
  const [notes, setNotes] = useState(plan.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const update = trpc.plans.update as unknown as {
      mutate: (i: { planId: string; title: string; notes: string | null; plannedFor: string | null }) => Promise<{ ok: true }>;
    };
    try {
      const plannedFor = date ? new Date(`${date}T12:00:00`).toISOString() : null;
      await update.mutate({ planId: plan.id, title, notes: notes.trim() ? notes : null, plannedFor });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save the plan.");
      setBusy(false);
    }
  }, [trpc, plan.id, title, date, notes, onSaved]);

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Plan title" maxLength={120} style={editInput} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Planned date" style={editInput} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" rows={3} placeholder="Notes (optional)" style={{ ...editInput, resize: "vertical", minHeight: 72 }} />
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void save()} disabled={title.trim().length === 0 || busy}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>Cancel</Button>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onDelete} style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 13, textDecoration: "underline" }}>
          Delete plan
        </button>
      </div>
    </Card>
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
