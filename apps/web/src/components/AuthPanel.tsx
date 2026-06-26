/**
 * AuthPanel — the just-in-time auth surface. The first sign-up prompt on the
 * read-mostly consumer surface (per the Stage 1 definition of done): browsing needs
 * no account, but the first WRITE (claiming a venue) does. This panel appears inline
 * at that moment, not as a gate on the whole app.
 *
 * Email + password, two modes:
 *   - SIGN IN (existing user): on success a session exists immediately; the caller's
 *     onAuthed() fires and the claim can proceed in the same sitting.
 *   - SIGN UP (new user): with email confirmation ON (the project's chosen default),
 *     signUp returns NO session — user + session are both null and the user must click
 *     the emailed link first. So sign-up does NOT call onAuthed; it shows a
 *     "check your email" state. The confirmation link redirects back to the venue page
 *     (emailRedirectTo), which resumes the claim once the session lands.
 *
 * This component owns ONLY auth + presentation. It holds no claim logic and no
 * business rules — it reports "you're now signed in" (onAuthed) and lets the caller
 * decide what that unlocks. It talks to Supabase through the browser client directly
 * (the session source the TrpcProvider already reads from), so a successful sign-in
 * flows into the existing token→RLS path with no extra wiring.
 */
"use client";

import { useState } from "react";
import { Button, Card } from "@roam/design";
import { getSupabaseBrowser } from "../lib/supabase";

type Mode = "signin" | "signup";

export interface AuthPanelProps {
  /**
   * Where the email-confirmation link should return the user. The caller passes the
   * venue URL with the claim-resume flag so a confirmed sign-up lands back ready to
   * finish claiming. Only used for sign-up (sign-in needs no redirect).
   */
  emailRedirectTo: string;
  /** Fired when a LIVE session now exists (sign-in success). Sign-up does NOT fire
   *  this — it has no session until email confirmation. */
  onAuthed: () => void;
  /** Optional context line shown above the form (e.g. why we're asking). */
  intro?: string;
}

export function AuthPanel({ emailRedirectTo, onAuthed, intro }: AuthPanelProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set after a sign-up that needs email confirmation — drives the "check inbox" view.
  const [confirmSent, setConfirmSent] = useState(false);

  async function submit() {
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and a password.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }

    setBusy(true);
    const supabase = getSupabaseBrowser();
    try {
      if (mode === "signin") {
        const { data, error: e } = await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
        if (e) {
          setError(friendlyAuthError(e.message));
          return;
        }
        if (data.session) {
          onAuthed();
          return;
        }
        // No session and no error is unexpected for sign-in; surface gently.
        setError("Couldn't sign you in. Please try again.");
      } else {
        const { data, error: e } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
          options: { emailRedirectTo },
        });
        if (e) {
          setError(friendlyAuthError(e.message));
          return;
        }
        // Email confirmation ON: session is null; user must confirm via email.
        // (If a session DID come back — confirmation off — proceed immediately.)
        if (data.session) {
          onAuthed();
          return;
        }
        setConfirmSent(true);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (confirmSent) {
    return (
      <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
        <div
          className="t-h3"
          style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}
        >
          Check your email
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
          We&apos;ve sent a confirmation link to <strong>{email.trim()}</strong>. Open it to
          confirm your account — you&apos;ll come straight back here, signed in.
        </p>
      </Card>
    );
  }

  return (
    <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
      {intro ? (
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          {intro}
        </p>
      ) : null}

      {/* mode toggle */}
      <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <ModeTab label="Sign in" active={mode === "signin"} onClick={() => setMode("signin")} />
        <ModeTab label="Create account" active={mode === "signup"} onClick={() => setMode("signup")} />
      </div>

      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          placeholder="you@business.com"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          placeholder={mode === "signup" ? "At least 8 characters" : ""}
        />

        {error ? (
          <div style={{ color: "var(--crimson-700)", fontSize: 13 }} role="alert">
            {error}
          </div>
        ) : null}

        <Button variant="pri" onClick={submit} disabled={busy} block>
          {busy
            ? "Please wait…"
            : mode === "signin"
              ? "Sign in"
              : "Create account"}
        </Button>
      </div>
    </Card>
  );
}

function ModeTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "var(--ui)",
        padding: "6px 2px",
        color: active ? "var(--ink-hi)" : "var(--muted)",
        borderBottom: active ? "2px solid var(--crimson)" : "2px solid transparent",
      }}
    >
      {label}
    </button>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        style={{
          fontFamily: "var(--ui)",
          fontSize: 14,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--line-2)",
          background: "#fff",
          color: "var(--ink)",
          outline: "none",
        }}
      />
    </label>
  );
}

/** Map Supabase's auth error strings to friendlier copy without leaking internals. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "That email or password doesn't match.";
  if (m.includes("already registered") || m.includes("already been registered")) {
    return "That email already has an account — try signing in instead.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  return "Couldn't complete that. Please check your details and try again.";
}
