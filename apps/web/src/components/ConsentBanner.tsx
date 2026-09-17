/**
 * ConsentBanner — the cookie/analytics consent prompt (holistic plan Phase 1.3; ARCHITECTURE.md
 * hard gate). Shown once per visitor until they choose; the choice is a first-party cookie for a
 * year (lib/consent.ts). Analytics loads only on "Accept"; "Essential only" keeps the site working
 * with no analytics at all — there is no dark pattern here: the two buttons are equal weight.
 *
 * Neutral tokens on purpose: it renders identically under Roam and storefront chrome, above the
 * TabBar on phones. Links to the privacy page of whichever host you are on.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { readConsent, writeConsent } from "../lib/consent";

export function ConsentBanner() {
  const t = useTranslations("consent");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(readConsent() === null);
  }, []);

  if (!open) return null;

  const choose = (choice: "granted" | "denied") => {
    writeConsent(choice);
    setOpen(false);
  };

  return (
    <div
      role="region"
      aria-label={t("title")}
      style={{
        position: "fixed",
        left: 12,
        right: 12,
        bottom: "calc(12px + env(safe-area-inset-bottom) + var(--tabbar-h, 0px))",
        zIndex: 60,
        margin: "0 auto",
        maxWidth: 640,
        padding: "14px 16px",
        borderRadius: 14,
        border: "1px solid var(--line)",
        background: "var(--paper)",
        color: "var(--ink)",
        boxShadow: "0 12px 32px rgba(0,0,0,.14)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 14 }}>{t("title")}</div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)" }}>
        {t("body")}{" "}
        <Link href="/legal/privacy" style={{ color: "var(--ink)", textDecoration: "underline" }}>
          {t("privacyLink")}
        </Link>
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => choose("granted")} style={{ ...btn, background: "var(--ink)", color: "var(--paper)", border: "1px solid var(--ink)" }}>
          {t("accept")}
        </button>
        <button type="button" onClick={() => choose("denied")} style={{ ...btn, background: "transparent", color: "var(--ink)", border: "1px solid var(--line)" }}>
          {t("essentialOnly")}
        </button>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  cursor: "pointer",
  padding: "9px 14px",
  borderRadius: 10,
  fontSize: 13.5,
  fontWeight: 700,
  fontFamily: "inherit",
};
