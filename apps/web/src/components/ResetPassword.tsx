/**
 * ResetPassword — the landing surface for a password-reset email link.
 *
 * Flow: AuthPanel's "Forgot your password?" calls supabase.auth.resetPasswordForEmail with
 * redirectTo = /reset-password. Supabase emails a recovery link; clicking it lands here with
 * a recovery token in the URL, which the browser client picks up (detectSessionInUrl) and
 * surfaces as a short-lived recovery session + a PASSWORD_RECOVERY event. With that session
 * in place, updateUser({ password }) sets the new password. No server route needed — the
 * recovery session authorises the write under the user's own auth.uid().
 *
 * Phases: "checking" (waiting for the recovery session to resolve from the URL) → "ready"
 * (show the set-password form) or "invalid" (no/expired token) → "done" (updated; they're
 * now signed in). The 2s fallback re-checks getSession directly in case the auth event
 * fired before our listener attached.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card } from "@roam/design";
import { getSupabaseBrowser } from "../lib/supabase";

type Phase = "checking" | "ready" | "invalid" | "done";

export function ResetPassword() {
  const t = useTranslations("resetPassword");
  const tAuth = useTranslations("auth");
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    let settled = false;
    const markReady = () => {
      if (settled) return;
      settled = true;
      setPhase("ready");
    };
    // The recovery link establishes a session asynchronously (detectSessionInUrl). Catch it
    // either via the auth event or by a direct getSession check shortly after mount.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) markReady();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) markReady();
        else setPhase("invalid");
      });
    }, 2000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function submit() {
    setError(null);
    if (password.length < 8) {
      setError(tAuth("errors.passwordMin"));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordsMismatch"));
      return;
    }
    setBusy(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error: e } = await supabase.auth.updateUser({ password });
      if (e) {
        setError(e.message);
        return;
      }
      setPhase("done");
    } catch {
      setError(tAuth("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      <h1
        className="t-h2"
        style={{ fontFamily: "var(--display)", textAlign: "center", marginBottom: "var(--space-2)" }}
      >
        {tAuth("resetTitle")}
      </h1>

      {phase === "checking" ? (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--ink-2)" }}>{t("verifying")}</p>
        </Card>
      ) : phase === "invalid" ? (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
          <div
            className="t-h3"
            style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}
          >
            {t("expiredTitle")}
          </div>
          <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
            {t("expiredBody")}
          </p>
          <a href="/account" style={{ textDecoration: "none" }}>
            <Button variant="pri" block>
              {tAuth("backToSignIn")}
            </Button>
          </a>
        </Card>
      ) : phase === "done" ? (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
          <div
            className="t-h3"
            style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}
          >
            {t("doneTitle")}
          </div>
          <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
            {t("doneBody")}
          </p>
          <a href="/account" style={{ textDecoration: "none" }}>
            <Button variant="pri" block>
              {t("goToAccount")}
            </Button>
          </a>
        </Card>
      ) : (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
          <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
            {t("chooseBody")}
          </p>
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            <Field
              label={t("newPassword")}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              placeholder={tAuth("passwordPlaceholder")}
            />
            <Field
              label={t("confirmPassword")}
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              placeholder={t("confirmPlaceholder")}
            />
            {error ? (
              <div style={{ color: "var(--crimson-700)", fontSize: 13 }} role="alert">
                {error}
              </div>
            ) : null}
            <Button variant="pri" onClick={submit} disabled={busy} block>
              {busy ? tAuth("pleaseWait") : t("setNewPassword")}
            </Button>
          </div>
        </Card>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  label: string;
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
        type="password"
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
