/**
 * PlansList — the /plans surface, redesigned to the hi-fi mockup: a kicker header
 * ("TOGETHER IN BELFAST" · Plans · subline · ＋ New plan), a two-up grid of image cards
 * (date chip over the header image, title over the scrim, an avatar stack + "N going"
 * footer with the plan's locality), and a ghost "Start a new plan" card closing the grid.
 *
 * Private (protected); signed out shows the just-in-time sign-in. A plan is a collection of
 * venues with a title, optional date and notes — shared with the friends you invite, and each
 * plan has its own group chat (managed on the plan's detail page).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, AvatarStack } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { useCurrentPlace } from "../lib/currentPlace";
import { planDateLabel } from "../lib/planDate";

interface PlanMemberAvatar {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface PlanRow {
  id: string;
  title: string;
  plannedFor: string | null;
  headerUrl: string | null;
  venueCount: number;
  locality: string | null;
  goingCount: number;
  memberAvatars: PlanMemberAvatar[];
}

/** Calm crimson gradient for plans without a custom header — matches PlanDetail. */
const PLAN_GRADIENT = "linear-gradient(135deg, var(--crimson) 0%, var(--crimson-700) 55%, #7a0c28 100%)";

export function PlansList() {
  const trpc = useTrpc();
  const session = useSession();
  const { place } = useCurrentPlace();
  const hasSession = !!session;
  const [plans, setPlans] = useState<PlanRow[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    const list = trpc.plans.list as unknown as { query: () => Promise<{ plans: PlanRow[] }> };
    const res = await list.query();
    return res.plans ?? [];
  }, [trpc]);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    setPlans(undefined);
    setError(null);
    load()
      .then((p) => {
        if (!cancelled) setPlans(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your plans.");
      });
    return () => {
      cancelled = true;
    };
  }, [hasSession, load]);

  const onCreated = useCallback(() => {
    setComposing(false);
    void load().then((p) => setPlans(p)).catch(() => {});
  }, [load]);

  return (
    <main style={{ maxWidth: 1060, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-4)", marginBottom: "var(--space-6)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
            Together in {place.name}
          </div>
          <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}>
            Plans
          </h1>
          <p style={{ margin: "6px 0 0", color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.5 }}>
            Line up an outing, add venues, and let the group decide where to meet.
          </p>
        </div>
        {hasSession && !composing ? (
          <Button variant="pri" onClick={() => setComposing(true)} style={{ flexShrink: 0 }}>
            ＋ New plan
          </Button>
        ) : null}
      </header>

      {!hasSession ? (
        <Card style={{ padding: "var(--space-4)" }}>
          <AuthPanel
            intro="Sign in to make plans and save venues to them."
            emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
            onAuthed={() => {}}
          />
        </Card>
      ) : (
        <>
          {composing ? <PlanComposer onCreated={onCreated} onCancel={() => setComposing(false)} /> : null}

          {error ? (
            <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
              <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
            </Card>
          ) : plans === undefined ? (
            <div style={grid}>
              <div style={{ height: 300, borderRadius: 20, background: "var(--paper-2)" }} />
              <div style={{ height: 300, borderRadius: 20, background: "var(--paper-2)" }} />
            </div>
          ) : (
            <div style={grid}>
              {plans.map((p) => (
                <PlanCard key={p.id} plan={p} />
              ))}
              <NewPlanCard onClick={() => setComposing(true)} />
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** Two-up (fluid) card grid — auto-fill keeps it inline-style-only, no media query needed. */
const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
  gap: "var(--space-5)",
  alignItems: "stretch",
};

/** A plan card per the mockup: date chip over the header image, title over the scrim, and a
 *  white footer with the avatar stack + "N going" and the plan's locality. */
function PlanCard({ plan }: { plan: PlanRow }) {
  return (
    <Link href={`/plans/${plan.id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card style={{ padding: 0, overflow: "hidden", height: "100%", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            position: "relative",
            height: 210,
            display: "flex",
            alignItems: "flex-end",
            background: plan.headerUrl ? "var(--paper-2)" : PLAN_GRADIENT,
            flexShrink: 0,
          }}
        >
          {plan.headerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
            <img src={plan.headerUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          ) : null}
          <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.12) 55%, rgba(0,0,0,0) 80%)" }} />
          <span
            style={{
              position: "absolute",
              top: "var(--space-4)",
              left: "var(--space-4)",
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "#fff",
              background: "rgba(20,16,14,.45)",
              backdropFilter: "blur(4px)",
              borderRadius: 999,
              padding: "4px 12px",
            }}
          >
            {plan.plannedFor ? planDateLabel(plan.plannedFor) : "No date yet"}
          </span>
          <div style={{ position: "relative", padding: "var(--space-4)", width: "100%" }}>
            <div className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 23, color: "#fff", textShadow: "0 1px 14px rgba(0,0,0,.4)", lineHeight: 1.25, letterSpacing: "-.015em" }}>
              {plan.title}
            </div>
          </div>
        </div>

        {/* Footer: who's going · where. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "12px var(--space-4)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            {plan.memberAvatars.length > 0 ? (
              <AvatarStack size={28}>
                {plan.memberAvatars.map((m) =>
                  m.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                    <img key={m.id} src={m.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span key={m.id} style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "var(--crimson-tint)", color: "var(--crimson-700)", fontSize: 12, fontWeight: 700 }}>
                      {(m.displayName ?? "·").trim().charAt(0).toUpperCase() || "·"}
                    </span>
                  ),
                )}
              </AvatarStack>
            ) : null}
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
              {plan.goingCount} going
            </span>
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {plan.locality ?? (plan.venueCount === 1 ? "1 venue" : `${plan.venueCount} venues`)}
          </span>
        </div>
      </Card>
    </Link>
  );
}

/** The ghost "Start a new plan" card closing the grid — the mockup's soft call to action. */
function NewPlanCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        minHeight: 264,
        borderRadius: 20,
        background: "var(--card)",
        border: "1px solid rgba(33,29,26,.05)",
        boxShadow: "var(--sh-1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        textAlign: "center",
        padding: "var(--space-5)",
      }}
    >
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)", fontSize: 22, fontWeight: 600 }}>
        +
      </span>
      <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, color: "var(--ink)" }}>Start a new plan</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--muted)" }}>Pick a date, invite friends</span>
    </button>
  );
}

function PlanComposer({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const trpc = useTrpc();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const create = trpc.plans.create as unknown as {
      mutate: (i: { title: string; notes: string | null; plannedFor: string | null }) => Promise<{ id: string }>;
    };
    try {
      // <input type="date"> gives YYYY-MM-DD; store as an ISO instant at local midnight.
      const plannedFor = date ? new Date(`${date}T12:00:00`).toISOString() : null;
      await create.mutate({ title, notes: notes.trim() ? notes : null, plannedFor });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the plan.");
      setBusy(false);
    }
  }, [trpc, title, date, notes, onCreated]);

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Plan title — e.g. Friday night out"
        aria-label="Plan title"
        maxLength={120}
        style={inputStyle}
      />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Planned date" style={inputStyle} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" rows={2} style={{ ...inputStyle, resize: "vertical", minHeight: 60 }} />
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void submit()} disabled={title.trim().length === 0 || busy}>
          {busy ? "Creating…" : "Create plan"}
        </Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </Card>
  );
}

const inputStyle: React.CSSProperties = {
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
