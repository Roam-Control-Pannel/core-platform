/**
 * SettingsHub — the /settings surface. A mobile-first list of grouped rows: your account (email,
 * sign-in method, change password, edit profile), notifications, legal documents, support/about,
 * and a danger zone (delete account) + sign out.
 *
 * Account/danger rows need a signed-in user; the LEGAL and SUPPORT groups render for everyone
 * (legal pages are public and must be reachable signed-out). Delete account is a permanent,
 * cascading erasure gated behind a typed confirmation (profiles.deleteMe on the API).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card } from "@roam/design";
import { useSession, useTrpc } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { BirthdaySettings } from "./BirthdaySettings";
import { getSupabaseBrowser } from "../lib/supabase";
import { useLocaleSetting } from "../lib/i18n/LocaleProvider";
import type { Locale } from "../lib/i18n/runtime";

const APP_VERSION = "1.0.0";
const SUPPORT_EMAIL = "support@roam-local.com";

export function SettingsHub() {
  const t = useTranslations("settings");
  const session = useSession();
  const router = useRouter();
  const trpc = useTrpc();

  const userId = session?.user?.id ?? null;
  const email = session?.user?.email ?? null;
  const provider = providerLabel(
    t,
    (session?.user?.app_metadata as { provider?: string } | undefined)?.provider,
  );

  const [signingOut, setSigningOut] = useState(false);
  const [pwState, setPwState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [showDelete, setShowDelete] = useState(false);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await getSupabaseBrowser().auth.signOut();
      router.push("/");
    } finally {
      setSigningOut(false);
    }
  }, [router]);

  const changePassword = useCallback(async () => {
    if (!email) return;
    setPwState("sending");
    try {
      const origin = window.location.origin;
      const { error } = await getSupabaseBrowser().auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/reset-password`,
      });
      setPwState(error ? "error" : "sent");
    } catch {
      setPwState("error");
    }
  }, [email]);

  const deleteAccount = useCallback(async () => {
    const del = trpc.profiles.deleteMe as unknown as { mutate: () => Promise<{ ok: boolean }> };
    await del.mutate();
    // Account is gone — clear the (now-invalid) session and leave for the public home.
    try {
      await getSupabaseBrowser().auth.signOut();
    } catch {
      /* session is already void server-side */
    }
    router.push("/");
  }, [trpc, router]);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-2) 0 var(--space-4)",
        }}
      >
        <Link
          href="/account"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}
        >
          <span aria-hidden>←</span> {t("back")}
        </Link>
        <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}>
          {t("title")}
        </h1>
        <span style={{ width: 1 }} />
      </header>

      {userId ? (
        <>
          <Group title={t("account.title")}>
            <ValueRow label={t("account.email")} value={email ?? "—"} />
            <ValueRow label={t("account.signInMethod")} value={provider} />
            <ActionRow
              label={t("account.changePassword")}
              value={
                pwState === "sent"
                  ? t("account.checkInbox")
                  : pwState === "sending"
                    ? t("account.sending")
                    : pwState === "error"
                      ? t("account.tryAgain")
                      : t("account.emailMeALink")
              }
              onClick={() => void changePassword()}
              disabled={pwState === "sending" || !email}
            />
            <LinkRow href="/account" label={t("account.editProfile")} />
          </Group>

          <Group title={t("notifications.title")}>
            <LinkRow href="/following" label={t("notifications.followedVenues")} value={t("notifications.manage")} />
            <LinkRow href="/notifications" label={t("notifications.yourNotifications")} />
          </Group>

          <BirthdaySettings />
        </>
      ) : null}

      <LanguageGroup />

      <Group title={t("legal.title")}>
        <LinkRow href="/legal/terms" label={t("legal.terms")} />
        <LinkRow href="/legal/privacy" label={t("legal.privacy")} />
        <LinkRow href="/legal/subscription" label={t("legal.subscription")} />
        <LinkRow href="/legal/community-guidelines" label={t("legal.guidelines")} />
        <LinkRow href="/legal/attributions" label={t("legal.attributions")} />
      </Group>

      <Group title={t("support.title")}>
        <ExternalRow href={`mailto:${SUPPORT_EMAIL}`} label={t("support.contact")} value={SUPPORT_EMAIL} />
        <ValueRow label={t("support.appVersion")} value={APP_VERSION} />
      </Group>

      {userId ? (
        <>
          <div style={{ marginTop: "var(--space-6)" }}>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              style={{
                all: "unset",
                boxSizing: "border-box",
                width: "100%",
                textAlign: "center",
                padding: "12px 16px",
                minHeight: 44,
                borderRadius: 12,
                border: "1px solid var(--line)",
                background: "var(--card)",
                fontFamily: "var(--ui)",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--ink)",
                cursor: signingOut ? "default" : "pointer",
              }}
            >
              {signingOut ? t("signingOut") : t("signOut")}
            </button>
          </div>

          <section style={{ marginTop: "var(--space-6)" }}>
            <h2
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--crimson-700)",
                margin: "0 0 var(--space-2)",
                paddingLeft: 4,
              }}
            >
              {t("danger.title")}
            </h2>
            <Card style={{ padding: "var(--space-4)", borderColor: "var(--crimson-tint-2)" }}>
              <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>
                {t("danger.deleteAccount")}
              </div>
              <p style={{ margin: "4px 0 var(--space-3)", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                {t("danger.deleteBody")}
              </p>
              <button
                type="button"
                onClick={() => setShowDelete(true)}
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  padding: "9px 16px",
                  minHeight: 44,
                  display: "inline-flex",
                  alignItems: "center",
                  borderRadius: 999,
                  border: "1px solid var(--crimson-tint-2)",
                  color: "var(--crimson-700)",
                  fontFamily: "var(--ui)",
                  fontSize: 13.5,
                  fontWeight: 700,
                }}
              >
                {t("danger.deleteAccount")}
              </button>
            </Card>
          </section>
        </>
      ) : (
        <div style={{ marginTop: "var(--space-4)" }}>
          <AuthPanel
            intro={t("signedOutIntro")}
            emailRedirectTo={typeof window !== "undefined" ? `${window.location.origin}/settings` : "/settings"}
            onAuthed={() => {
              /* session change re-renders signed-in */
            }}
          />
        </div>
      )}

      {showDelete ? (
        <DeleteAccountModal onClose={() => setShowDelete(false)} onConfirm={deleteAccount} />
      ) : null}
    </main>
  );
}

/* ── language ────────────────────────────────────────────────────────────────────────────── */

/**
 * The app-language picker (renders for everyone, like Legal — no account needed). Writes the
 * preference cookie and swaps the catalogue live via LocaleProvider. Community content is NOT
 * translated by this — the hint says so and points at the browser's own translation.
 */
function LanguageGroup() {
  const t = useTranslations("settings.language");
  const { locale, setLocale, options } = useLocaleSetting();
  return (
    <Group title={t("title")}>
      <div style={rowInner}>
        <label
          htmlFor="app-language"
          style={{ fontFamily: "var(--ui)", fontSize: 14.5, fontWeight: 600, color: "var(--ink)" }}
        >
          {t("label")}
        </label>
        <select
          id="app-language"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          style={{
            fontFamily: "var(--ui)",
            fontSize: 13.5,
            color: "var(--ink-2)",
            background: "var(--paper)",
            border: "1px solid var(--line-2)",
            borderRadius: 10,
            padding: "8px 10px",
            maxWidth: 200,
          }}
        >
          {options.map((o) => (
            // Language names are endonyms ("Polski", "Cymraeg") — never translated.
            <option key={o.code} value={o.code} translate="no">
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <p
        style={{
          margin: 0,
          padding: "10px var(--space-4) 14px",
          borderTop: "1px solid var(--line)",
          fontSize: 12.5,
          color: "var(--muted)",
          lineHeight: 1.5,
        }}
      >
        {t("hint")}
      </p>
    </Group>
  );
}

/* ── grouped rows ────────────────────────────────────────────────────────────────────────── */

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--space-5)" }}>
      <h2
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          margin: "0 0 var(--space-2)",
          paddingLeft: 4,
        }}
      >
        {title}
      </h2>
      <Card style={{ padding: 0, overflow: "hidden" }}>{children}</Card>
    </section>
  );
}

const rowInner: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "14px var(--space-4)",
  minHeight: 52,
  borderTop: "1px solid var(--line)",
};

function RowBody({ label, value, chevron, danger }: { label: string; value?: string; chevron?: boolean; danger?: boolean }) {
  return (
    <>
      <span style={{ fontFamily: "var(--ui)", fontSize: 14.5, fontWeight: 600, color: danger ? "var(--crimson-700)" : "var(--ink)" }}>
        {label}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {value ? (
          <span style={{ fontSize: 13.5, color: "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}>
            {value}
          </span>
        ) : null}
        {chevron ? <span aria-hidden style={{ color: "var(--faint)", fontSize: 18 }}>›</span> : null}
      </span>
    </>
  );
}

function LinkRow({ href, label, value }: { href: string; label: string; value?: string }) {
  return (
    <Link href={href} style={{ ...rowInner, textDecoration: "none" }}>
      <RowBody label={label} {...(value !== undefined ? { value } : {})} chevron />
    </Link>
  );
}

function ExternalRow({ href, label, value }: { href: string; label: string; value?: string }) {
  return (
    <a href={href} style={{ ...rowInner, textDecoration: "none" }}>
      <RowBody label={label} {...(value !== undefined ? { value } : {})} chevron />
    </a>
  );
}

function ActionRow({ label, value, onClick, disabled }: { label: string; value?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ all: "unset", boxSizing: "border-box", width: "100%", cursor: disabled ? "default" : "pointer", ...rowInner }}
    >
      <RowBody label={label} {...(value !== undefined ? { value } : {})} />
    </button>
  );
}

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={rowInner}>
      <RowBody label={label} value={value} />
    </div>
  );
}

/* ── delete confirmation ─────────────────────────────────────────────────────────────────── */

function DeleteAccountModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => Promise<void> }) {
  const t = useTranslations("settings.danger");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = text.trim().toUpperCase() === "DELETE";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, busy]);

  const confirm = useCallback(async () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("deleteFailed"));
      setBusy(false);
    }
  }, [armed, busy, onConfirm]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("deleteAccount")}
      onClick={() => !busy && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "start center",
        padding: "var(--space-8) var(--space-3)",
        background: "rgba(20, 14, 16, 0.55)",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 440,
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 18,
          boxShadow: "var(--shadow-pop)",
          padding: "var(--space-5)",
        }}
      >
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 19, margin: 0, color: "var(--ink)" }}>
          {t("modalTitle")}
        </h2>
        <p style={{ margin: "var(--space-2) 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
          {t("modalBody")}
        </p>
        <label style={{ display: "block", margin: "var(--space-4) 0 6px", fontSize: 12.5, color: "var(--ink-2)" }}>
          {/* The confirmation word itself stays DELETE in every language (it's what armed checks). */}
          {t.rich("typeToConfirm", { word: "DELETE", strong: (chunks) => <strong style={{ color: "var(--ink)" }}>{chunks}</strong> })}
        </label>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          disabled={busy}
          placeholder="DELETE"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "11px 14px",
            borderRadius: 10,
            border: "1px solid var(--line-2)",
            fontFamily: "var(--ui)",
            fontSize: 15,
            background: "var(--paper)",
            color: "var(--ink)",
          }}
        />
        {error ? (
          <p style={{ margin: "var(--space-2) 0 0", fontSize: 13, color: "var(--crimson-700)" }}>{error}</p>
        ) : null}
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            style={{
              all: "unset",
              boxSizing: "border-box",
              flex: 1,
              textAlign: "center",
              padding: "11px 16px",
              minHeight: 44,
              borderRadius: 999,
              border: "1px solid var(--line)",
              background: "var(--card)",
              fontFamily: "var(--ui)",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ink)",
              cursor: busy ? "default" : "pointer",
            }}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!armed || busy}
            style={{
              all: "unset",
              boxSizing: "border-box",
              flex: 1,
              textAlign: "center",
              padding: "11px 16px",
              minHeight: 44,
              borderRadius: 999,
              background: armed && !busy ? "var(--crimson-700)" : "var(--crimson-tint-2)",
              color: armed && !busy ? "#fff" : "var(--faint)",
              fontFamily: "var(--ui)",
              fontSize: 14,
              fontWeight: 700,
              cursor: armed && !busy ? "pointer" : "default",
            }}
          >
            {busy ? t("deleting") : t("deleteAccount")}
          </button>
        </div>
      </div>
    </div>
  );
}

function providerLabel(t: ReturnType<typeof useTranslations>, p?: string): string {
  switch (p) {
    case "google":
      return "Google";
    case "apple":
      return "Apple";
    case "email":
      return t("account.emailPassword");
    default:
      return p ? p.charAt(0).toUpperCase() + p.slice(1) : t("account.emailPassword");
  }
}
