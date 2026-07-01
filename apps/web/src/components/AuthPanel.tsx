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

import { useState, type ReactNode } from "react";
import { Button, Card } from "@roam/design";
import { getSupabaseBrowser } from "../lib/supabase";

type Mode = "signin" | "signup" | "reset";

/** A social sign-in provider we offer, when enabled. */
type SsoProvider = { id: "google" | "apple"; label: string };

/**
 * SSO providers to show — gated per-provider by a build-time env flag so a button only appears
 * once its provider is actually configured in Supabase (no dead buttons). Google is free to
 * enable; Apple needs the Apple Developer Program, so it lights up independently.
 */
const SSO_PROVIDERS: SsoProvider[] = [
  process.env.NEXT_PUBLIC_ENABLE_GOOGLE_SSO === "1" ? { id: "google" as const, label: "Google" } : null,
  process.env.NEXT_PUBLIC_ENABLE_APPLE_SSO === "1" ? { id: "apple" as const, label: "Apple" } : null,
].filter((p): p is SsoProvider => p !== null);

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
  // Set after a password-reset request — drives the "check inbox for a reset link" view.
  const [resetSent, setResetSent] = useState(false);

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

  /** Send a password-reset email. Supabase emails a recovery link that lands on
   *  /reset-password, where the user sets a new password. For privacy we show the same
   *  "check your inbox" state whether or not the address has an account (no enumeration). */
  async function sendReset() {
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter your email and we'll send a reset link.");
      return;
    }
    setBusy(true);
    const supabase = getSupabaseBrowser();
    try {
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error: e } = await supabase.auth.resetPasswordForEmail(trimmedEmail, { redirectTo });
      if (e) {
        setError(friendlyAuthError(e.message));
        return;
      }
      setResetSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Start an OAuth (SSO) sign-in. signInWithOAuth redirects the whole browser to the provider;
   * on success this page unloads, so no code after it runs. We send the provider back to
   * /auth/callback with a `next` of wherever the caller wanted the user to land (emailRedirectTo,
   * falling back to the current URL) — the callback waits for the session, then forwards there.
   * An immediate error (e.g. provider misconfigured) is surfaced without leaving the page.
   */
  async function signInWithProvider(provider: SsoProvider["id"]) {
    setError(null);
    setBusy(true);
    try {
      const supabase = getSupabaseBrowser();
      const next = emailRedirectTo || window.location.href;
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: e } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
      if (e) {
        setError(friendlyAuthError(e.message));
        setBusy(false);
      }
      // Success → browser navigates to the provider; nothing else here runs.
    } catch {
      setError("Couldn't start sign-in. Please try again.");
      setBusy(false);
    }
  }

  /** Return to the sign-in view from the reset sub-flow, clearing its transient state. */
  function backToSignIn() {
    setMode("signin");
    setResetSent(false);
    setError(null);
  }

  if (resetSent) {
    return (
      <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
        <div
          className="t-h3"
          style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}
        >
          Check your email
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
          If an account exists for <strong>{email.trim()}</strong>, we&apos;ve sent a link to reset
          your password. Open it to choose a new one.
        </p>
        <div style={{ marginTop: "var(--space-4)" }}>
          <LinkButton onClick={backToSignIn}>Back to sign in</LinkButton>
        </div>
      </Card>
    );
  }

  if (mode === "reset") {
    return (
      <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
        <div
          className="t-h3"
          style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}
        >
          Reset your password
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          Enter your account email and we&apos;ll send you a link to set a new password.
        </p>
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            placeholder="you@business.com"
          />
          {error ? (
            <div style={{ color: "var(--crimson-700)", fontSize: 13 }} role="alert">
              {error}
            </div>
          ) : null}
          <Button variant="pri" onClick={sendReset} disabled={busy} block>
            {busy ? "Please wait…" : "Send reset link"}
          </Button>
          <div style={{ textAlign: "center" }}>
            <LinkButton onClick={backToSignIn}>Back to sign in</LinkButton>
          </div>
        </div>
      </Card>
    );
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

      {/* SSO — one tap for sign-in OR sign-up (OAuth creates the account if new). Only the
          providers configured in Supabase render (env-gated), so there are never dead buttons. */}
      {SSO_PROVIDERS.length > 0 ? (
        <>
          <div style={{ display: "grid", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
            {SSO_PROVIDERS.map((p) => (
              <SsoButton key={p.id} provider={p} disabled={busy} onClick={() => void signInWithProvider(p.id)} />
            ))}
          </div>
          <OrDivider />
        </>
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

        {mode === "signin" ? (
          <div style={{ textAlign: "center" }}>
            <LinkButton
              onClick={() => {
                setMode("reset");
                setError(null);
              }}
            >
              Forgot your password?
            </LinkButton>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** A social sign-in button (outlined, provider logo + "Continue with X"). */
function SsoButton({
  provider,
  disabled,
  onClick,
}: {
  provider: SsoProvider;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: disabled ? "default" : "pointer",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        minHeight: 44,
        padding: "10px 14px",
        borderRadius: 10,
        border: "1px solid var(--line-2)",
        background: "#fff",
        opacity: disabled ? 0.6 : 1,
        fontFamily: "var(--ui)",
        fontSize: 14,
        fontWeight: 600,
        color: "var(--ink)",
      }}
    >
      {provider.id === "google" ? <GoogleMark /> : <AppleMark />}
      <span>Continue with {provider.label}</span>
    </button>
  );
}

/** A horizontal "or" divider between the SSO buttons and the email form. */
function OrDivider() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
      <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
      <span style={{ fontFamily: "var(--ui)", fontSize: 11, color: "var(--muted)" }}>or</span>
      <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
    </div>
  );
}

/** Google's multi-colour "G" mark. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

/** Apple's monochrome logo. */
function AppleMark() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" fill="var(--ink)" aria-hidden focusable="false">
      <path d="M13.5 13.9c-.24.56-.53 1.08-.86 1.55-.46.66-.83 1.11-1.12 1.36-.44.41-.92.62-1.43.63-.37 0-.81-.1-1.32-.31-.51-.21-.98-.31-1.41-.31-.45 0-.93.1-1.45.31-.52.21-.94.32-1.26.33-.49.02-.98-.2-1.47-.64-.31-.27-.7-.73-1.17-1.38-.5-.7-.92-1.5-1.24-2.42-.34-.99-.52-1.95-.52-2.89 0-1.08.23-2.01.7-2.79.36-.62.85-1.11 1.46-1.47a3.9 3.9 0 0 1 1.98-.56c.39 0 .9.12 1.53.35.63.23 1.03.35 1.21.35.13 0 .58-.14 1.34-.41.72-.25 1.32-.36 1.82-.32 1.34.11 2.35.64 3.02 1.59-1.2.73-1.79 1.74-1.78 3.05.01 1.02.38 1.86 1.11 2.53.33.31.7.55 1.11.72-.09.26-.18.5-.28.73zM10.6.36c0 .81-.3 1.56-.88 2.26-.71.82-1.57 1.3-2.5 1.22a2.5 2.5 0 0 1-.02-.3c0-.77.34-1.6.94-2.28.3-.35.68-.64 1.15-.87.46-.23.9-.36 1.31-.38.01.12.02.23.02.35z" />
    </svg>
  );
}

/** A plain text link styled as a subtle inline action (forgot-password / back to sign in). */
function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "var(--ui)",
        color: "var(--muted)",
      }}
    >
      {children}
    </button>
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
