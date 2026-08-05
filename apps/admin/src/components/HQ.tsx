/**
 * HQ — the Roam HQ shell. Two gates then the app:
 *   1. Session — signed out shows the magic-link sign-in (Supabase OTP).
 *   2. Staff   — adminMetrics.me; a signed-in non-staff user gets "not authorised".
 *
 * The signed-in app is a fixed left sidebar (brand · nav · role) beside a scrolling
 * content column that swaps between the Overview / Moderation / Lookup / Audit views.
 * The sidebar's Moderation badge is the live count of things needing action.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession, useTrpc } from "./TrpcProvider";
import { getSupabaseBrowser } from "../lib/supabase";
import { C, F } from "../theme";
import { Kicker, Panel } from "./ui";
import { OverviewView } from "./views/Overview";
import { ModerationView } from "./views/Moderation";
import { LookupView } from "./views/Lookup";
import { AuditView } from "./views/AuditTrail";

type View = "overview" | "moderation" | "lookup" | "audit";
type Gate = "checking" | "ok" | "forbidden" | "error";
interface Me { id: string; role: string }

const NAV: Array<{ key: View; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "moderation", label: "Moderation" },
  { key: "lookup", label: "Lookup" },
  { key: "audit", label: "Audit trail" },
];

export function HQ() {
  const session = useSession();
  if (!session) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "grid", placeItems: "center", padding: 24 }}>
        <SignIn />
      </div>
    );
  }
  return <Authed />;
}

function Authed() {
  const trpc = useTrpc();
  const [gate, setGate] = useState<Gate>("checking");
  const [me, setMe] = useState<Me | null>(null);
  const [message, setMessage] = useState("");
  const [view, setView] = useState<View>("overview");
  const [modBadge, setModBadge] = useState<number>(0);
  const [email, setEmail] = useState<string>("");

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
        if (/staff-only|forbidden/i.test(msg)) setGate("forbidden");
        else {
          setMessage(msg);
          setGate("error");
        }
      });
    getSupabaseBrowser().auth.getUser().then(({ data }) => {
      if (!cancelled) setEmail(data.user?.email ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  // Live moderation badge (reports + flags + pending claims).
  const refreshBadge = useCallback(() => {
    (trpc.adminMetrics.needsYou.query() as Promise<{ reportsPending: number; claimsPending: number; flaggedProfiles: number }>)
      .then((n) => setModBadge(n.reportsPending + n.claimsPending + n.flaggedProfiles))
      .catch(() => {});
  }, [trpc]);
  useEffect(() => {
    if (gate === "ok") refreshBadge();
  }, [gate, refreshBadge]);

  if (gate !== "ok") {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "grid", placeItems: "center", padding: 24 }}>
        {gate === "checking" ? (
          <Gate title="Checking access…" body="Verifying your Roam HQ membership." />
        ) : gate === "forbidden" ? (
          <Gate title="Not on the Roam HQ list" body="Roam HQ is staff-only. Ask an owner to add you to the admin list." />
        ) : (
          <Gate title="Couldn't verify access" body={message || "Please try again."} />
        )}
      </div>
    );
  }

  const role = me?.role ?? "viewer";
  const canAct = role === "admin" || role === "owner";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", color: C.ink, fontFamily: F.ui }}>
      <Sidebar view={view} setView={setView} role={role} email={email} modBadge={modBadge} />
      <main style={{ flex: 1, minWidth: 0, maxWidth: 1360, margin: "0 auto", padding: "28px 32px 64px" }}>
        {view === "overview" ? (
          <OverviewView onGoModeration={() => setView("moderation")} />
        ) : view === "moderation" ? (
          <ModerationView canAct={canAct} onChanged={refreshBadge} />
        ) : view === "lookup" ? (
          <LookupView canAct={canAct} onChanged={refreshBadge} />
        ) : (
          <AuditView />
        )}
      </main>
      <style>{`
        @media (max-width: 900px){
          .hq-sidebar{ position: static !important; width: 100% !important; height: auto !important; border-right: none !important; border-bottom: 1px solid ${C.line} !important; }
          .hq-root{ flex-direction: column !important; }
        }
      `}</style>
    </div>
  );
}

function Sidebar({
  view,
  setView,
  role,
  email,
  modBadge,
}: {
  view: View;
  setView: (v: View) => void;
  role: string;
  email: string;
  modBadge: number;
}) {
  const signOut = () => getSupabaseBrowser().auth.signOut();
  return (
    <aside
      className="hq-sidebar"
      style={{
        width: 232,
        flexShrink: 0,
        borderRight: `1px solid ${C.line}`,
        background: C.bg,
        padding: "28px 20px",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 0,
        alignSelf: "flex-start",
        height: "100vh",
        boxSizing: "border-box",
      }}
    >
      <div style={{ borderBottom: `1px solid ${C.line}`, paddingBottom: 18, marginBottom: 18 }}>
        <Kicker>Roam · Internal</Kicker>
        <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22, letterSpacing: "-.02em", marginTop: 4 }}>Roam HQ</div>
      </div>

      <nav style={{ display: "grid", gap: 2 }}>
        {NAV.map((n) => {
          const active = view === n.key;
          return (
            <button
              key={n.key}
              type="button"
              onClick={() => setView(n.key)}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "9px 12px",
                borderRadius: 4,
                fontSize: 14,
                fontWeight: active ? 700 : 500,
                color: active ? C.ink : C.inkSoft,
                background: active ? "#FFFFFF" : "transparent",
                border: `1px solid ${active ? C.line : "transparent"}`,
              }}
            >
              <span>{n.label}</span>
              {n.key === "moderation" && modBadge > 0 ? (
                <span style={{ fontFamily: F.mono, fontSize: 11, fontWeight: 700, color: "#fff", background: C.red, borderRadius: 3, padding: "1px 6px" }}>
                  {modBadge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto", paddingTop: 18, borderTop: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: F.mono, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#fff", background: C.red, borderRadius: 3, padding: "2px 6px" }}>
            {role}
          </span>
          <span style={{ fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
        </div>
        <button
          type="button"
          onClick={signOut}
          style={{ all: "unset", cursor: "pointer", marginTop: 12, fontFamily: F.mono, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: C.muted }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function Gate({ title, body }: { title: string; body: string }) {
  return (
    <Panel style={{ padding: 32, maxWidth: 460 }}>
      <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22, marginBottom: 8 }}>{title}</div>
      <p style={{ color: C.inkSoft, lineHeight: 1.55, margin: 0, fontSize: 14 }}>{body}</p>
    </Panel>
  );
}

/** Magic-link sign-in (Supabase OTP). */
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
    <Panel style={{ padding: 32, maxWidth: 420, width: "100%" }}>
      <Kicker>Roam · Internal</Kicker>
      <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 26, letterSpacing: "-.02em", margin: "4px 0 8px" }}>Roam HQ</div>
      <p style={{ color: C.inkSoft, lineHeight: 1.5, marginBottom: 20, fontSize: 14 }}>
        Staff only. Enter your Roam email and we&apos;ll send a magic sign-in link.
      </p>
      {state === "sent" ? (
        <div style={{ padding: "12px 14px", borderRadius: 4, background: "#EAF3EC", color: "#1F6B41", fontSize: 13 }}>
          Check your email for a sign-in link.
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: "grid", gap: 10 }}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@roam-everywhere.com"
            aria-label="Email address"
            style={inputStyle}
          />
          <button type="submit" disabled={state === "sending" || email.trim().length === 0} style={primaryBtn}>
            {state === "sending" ? "Sending…" : "Send magic link"}
          </button>
          {state === "error" ? <div style={{ fontSize: 12, color: C.redInk }}>{message}</div> : null}
        </form>
      )}
    </Panel>
  );
}

const inputStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "11px 13px",
  background: "#fff",
  border: `1px solid ${C.lineStrong}`,
  borderRadius: 4,
  fontFamily: F.ui,
  fontSize: 14,
  color: C.ink,
  outline: "none",
};

const primaryBtn: React.CSSProperties = {
  all: "unset",
  textAlign: "center",
  cursor: "pointer",
  padding: "11px 14px",
  background: C.red,
  color: "#fff",
  borderRadius: 4,
  fontFamily: F.ui,
  fontSize: 14,
  fontWeight: 700,
};
