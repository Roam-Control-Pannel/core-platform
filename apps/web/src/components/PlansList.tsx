/**
 * PlansList — the /plans surface: your plans (personal venue itineraries) and a quick composer
 * to start one. Private (protected); signed out shows the just-in-time sign-in.
 *
 * A plan is a collection of venues with a title, optional date and notes — shared with the
 * friends you invite, and each plan has its own group chat (managed on the plan's detail page).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { planDateLabel } from "../lib/planDate";

interface PlanRow {
  id: string;
  title: string;
  plannedFor: string | null;
  headerUrl: string | null;
  venueCount: number;
}

/** Calm crimson gradient for plans without a custom header — matches PlanDetail. */
const PLAN_GRADIENT = "linear-gradient(135deg, var(--crimson) 0%, var(--crimson-700) 55%, #7a0c28 100%)";

export function PlansList() {
  const trpc = useTrpc();
  const session = useSession();
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
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> Home
      </Link>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0 }}>
          Plans
        </h1>
        {hasSession && !composing ? (
          <Button variant="pri" size="sm" onClick={() => setComposing(true)}>
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
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              <div style={{ height: 72, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
              <div style={{ height: 72, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
            </div>
          ) : plans.length === 0 ? (
            <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
              <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
                No plans yet
              </div>
              <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
                Make a plan — a night out, a weekend, a list to try — then add venues to it from anywhere on Roam.
              </p>
            </Card>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {plans.map((p) => (
                <PlanRowCard key={p.id} plan={p} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** A plan in the list: a header banner (custom image or gradient) with the title + date
 *  overlaid, and a venue-count footer. Reads like a card — the look that shines on mobile. */
function PlanRowCard({ plan }: { plan: PlanRow }) {
  return (
    <Link href={`/plans/${plan.id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            position: "relative", minHeight: 124, display: "flex", alignItems: "flex-end",
            background: plan.headerUrl ? "var(--paper-2)" : PLAN_GRADIENT,
          }}
        >
          {plan.headerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
            <img src={plan.headerUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          ) : null}
          <div aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.1) 50%, rgba(0,0,0,0) 78%)" }} />
          <div style={{ position: "relative", padding: "var(--space-4)", width: "100%" }}>
            {plan.plannedFor ? (
              <span style={{ display: "inline-block", marginBottom: 6, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".04em", textTransform: "uppercase", color: "#fff", background: "rgba(255,255,255,.18)", borderRadius: 999, padding: "2px 9px" }}>
                {planDateLabel(plan.plannedFor)}
              </span>
            ) : null}
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 19, color: "#fff", textShadow: "0 1px 12px rgba(0,0,0,.35)", lineHeight: 1.25 }}>
              {plan.title}
            </div>
          </div>
        </div>
        <div style={{ padding: "10px var(--space-4)", fontSize: 12.5, color: "var(--muted)" }}>
          {plan.venueCount === 1 ? "1 venue" : `${plan.venueCount} venues`}
        </div>
      </Card>
    </Link>
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
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
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
