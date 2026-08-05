/**
 * HQ — the Roam HQ dashboard root. Two gates, in order:
 *
 *   1. Session — signed out shows a magic-link sign-in (Supabase OTP). Roam HQ is its
 *      own origin, so staff authenticate here directly; there is no valid anonymous state.
 *   2. Staff — with a session, we call adminMetrics.me. Success (a role) unlocks the
 *      dashboard; a FORBIDDEN throw means "signed in but not staff", shown as not-authorised.
 *
 * The dashboard itself is observe-only in v1: Pulse, Growth + Content breakdown, the live
 * Activity feed alongside the Trust & safety queue, and staff Lookup. Actions land in Phase 3.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Card, Pill, Button } from "@roam/design";
import { useSession, useTrpc } from "./TrpcProvider";
import { getSupabaseBrowser } from "../lib/supabase";
import { Kicker } from "./ui";
import { Pulse } from "./Pulse";
import { Growth } from "./Growth";
import { ContentBreakdown } from "./ContentBreakdown";
import { ActivityFeed } from "./ActivityFeed";
import { ModerationQueue } from "./ModerationQueue";
import { Lookup } from "./Lookup";
import { AuditLog } from "./AuditLog";

type Gate = "checking" | "ok" | "forbidden" | "error";

interface Me {
  id: string;
  role: string;
}

export function HQ() {
  const session = useSession();
  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-16)" }}>
      <Header session={session} />
      {!session ? <SignIn /> : <StaffGate />}
    </main>
  );
}

function Header({ session }: { session: Session | null }) {
  const signOut = useCallback(() => {
    getSupabaseBrowser().auth.signOut();
  }, []);
  return (
    <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", padding: "var(--space-2) 0 var(--space-6)" }}>
      <div>
        <Kicker tone="crimson">Roam · internal</Kicker>
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, margin: "4px 0 0" }}>Roam HQ</h1>
      </div>
      {session ? (
        <button
          type="button"
          onClick={signOut}
          style={{ all: "unset", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", textDecoration: "underline" }}
        >
          Sign out
        </button>
      ) : null}
    </header>
  );
}

/** The staff check. Runs adminMetrics.me; renders the dashboard only on success. */
function StaffGate() {
  const trpc = useTrpc();
  const [gate, setGate] = useState<Gate>("checking");
  const [me, setMe] = useState<Me | null>(null);
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.me.query() as Promise<Me>)
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        setGate("ok");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        // adminProcedure throws FORBIDDEN for a signed-in non-staff user.
        if (/staff-only|FORBIDDEN|Forbidden/i.test(msg)) setGate("forbidden");
        else {
          setMessage(msg);
          setGate("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  if (gate === "checking") return <GateCard title="Checking access…" body="One moment while we verify your Roam HQ membership." />;
  if (gate === "forbidden")
    return (
      <GateCard
        title="You're signed in, but not on the Roam HQ list"
        body="Roam HQ is staff-only. If you think you should have access, ask an owner to add you to the admin list."
      />
    );
  if (gate === "error") return <GateCard title="Couldn't verify access" body={message || "Please try again."} />;

  return <Dashboard role={me?.role ?? "viewer"} />;
}

function Dashboard({ role }: { role: string }) {
  const canAct = role === "admin" || role === "owner";
  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Pill variant="ghost-crim" size="sm">{role}</Pill>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{canAct ? "can act" : "observe-only"}</span>
      </div>

      <Pulse />

      <div style={{ display: "grid", gap: "var(--space-4)" }}>
        <Growth />
        <ContentBreakdown />
      </div>

      <div style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)" }} className="hq-two-col">
        <ActivityFeed />
        <ModerationQueue canAct={canAct} />
      </div>

      <Lookup canAct={canAct} />

      {canAct ? <AuditLog /> : null}

      <style>{`@media (max-width: 860px){ .hq-two-col{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function GateCard({ title, body }: { title: string; body: string }) {
  return (
    <Card flat style={{ padding: "var(--space-6)", maxWidth: 560 }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>{title}</div>
      <p style={{ color: "var(--ink-2)", lineHeight: 1.55, margin: 0 }}>{body}</p>
    </Card>
  );
}

/** Magic-link sign-in (Supabase OTP). Staff authenticate on the HQ origin directly. */
function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  const send = useCallback(async () => {
    const addr = email.trim();
    if (!addr) return;
    setState("sending");
    try {
      const supabase = getSupabaseBrowser();
      const options = typeof window !== "undefined" ? { emailRedirectTo: window.location.origin } : {};
      const { error } = await supabase.auth.signInWithOtp({ email: addr, options });
      if (error) throw error;
      setState("sent");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not send the sign-in link.");
      setState("error");
    }
  }, [email]);

  return (
    <Card flat style={{ padding: "var(--space-6)", maxWidth: 460 }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>Sign in to Roam HQ</div>
      <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
        Staff only. Enter your Roam email and we&apos;ll send a magic sign-in link.
      </p>
      {state === "sent" ? (
        <div style={{ padding: "var(--space-3) var(--space-4)", borderRadius: 10, background: "var(--success-tint)", color: "var(--success)", fontSize: 13 }}>
          Check your email for a sign-in link.
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          style={{ display: "grid", gap: "var(--space-2)" }}
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@roam-everywhere.com"
            aria-label="Email address"
            style={{
              boxSizing: "border-box",
              padding: "10px 12px",
              background: "var(--paper-2)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              fontFamily: "var(--ui)",
              fontSize: 14,
              color: "var(--ink)",
              outline: "none",
            }}
          />
          <Button variant="pri" onClick={() => void send()} disabled={state === "sending" || email.trim().length === 0}>
            {state === "sending" ? "Sending…" : "Send magic link"}
          </Button>
          {state === "error" ? <div style={{ fontSize: 12, color: "var(--crimson-700)" }}>{message}</div> : null}
        </form>
      )}
    </Card>
  );
}
