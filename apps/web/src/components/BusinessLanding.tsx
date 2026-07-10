/**
 * BusinessLanding — /business, the public "business door".
 *
 * Roam has ONE kind of account (a person). "Business owner" isn't a separate account type —
 * it's a capability a person unlocks by CLAIMING + VERIFYING a venue. This page is the
 * intent-driven entry into that journey: it explains the offer (your venue is probably
 * already on Roam from public sources; claiming lets you keep it accurate) and routes into
 * the existing flow — find your venue → "Claim it free" → verify → manage in /dashboard.
 *
 * No new account model: signed-out visitors sign in with the same auth when they claim; the
 * claim/approve flow is the real trust boundary. (Teams / multi-owner "organizations" are a
 * later layer on top of this — deliberately not forked here.)
 */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Card, Icon} from "@roam/design";
import { useSession } from "./TrpcProvider";

/** Step numbers → catalogue key groups (businessLanding.steps.*). */
const STEPS: { n: string; key: string }[] = [
  { n: "1", key: "find" },
  { n: "2", key: "claim" },
  { n: "3", key: "verify" },
];

/** Catalogue keys for the "once you've claimed" perks (businessLanding.perks.*). */
const PERK_KEYS = ["photos", "hours", "description", "followers"];

export function BusinessLanding() {
  const t = useTranslations("businessLanding");
  const session = useSession();
  const signedIn = !!session?.user?.id;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ padding: "var(--space-2) 0 var(--space-4)" }}>
        <Link href="/explore" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <span aria-hidden>←</span> {t("back")}
        </Link>
      </header>

      {/* Hero */}
      <section style={{ textAlign: "center", padding: "var(--space-6) 0 var(--space-8)" }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--crimson-700)",
          }}
        >
          {t("kicker")}
        </span>
        <h1
          className="t-h1"
          style={{ fontFamily: "var(--display)", fontWeight: 700, margin: "var(--space-2) 0 var(--space-3)", fontSize: 34, lineHeight: 1.1 }}
        >
          {t("title")}
        </h1>
        <p style={{ maxWidth: 520, margin: "0 auto", color: "var(--ink-2)", lineHeight: 1.6, fontSize: 16 }}>
          {t("heroBody")}
        </p>

        <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "center", flexWrap: "wrap", marginTop: "var(--space-5)" }}>
          <Link href="/explore" style={{ textDecoration: "none" }}>
            <Button variant="pri">{t("findYourBusiness")}</Button>
          </Link>
          <Link href="/dashboard" style={{ textDecoration: "none" }}>
            <Button variant="neutral">{signedIn ? t("yourDashboard") : t("alreadyClaimed")}</Button>
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section style={{ marginTop: "var(--space-4)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
          {t("howItWorks")}
        </h2>
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {STEPS.map((s) => (
            <Card key={s.n} style={{ padding: "var(--space-4)" }}>
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: "var(--crimson-tint)",
                    color: "var(--crimson-700)",
                    display: "grid",
                    placeItems: "center",
                    fontFamily: "var(--mono)",
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {s.n}
                </span>
                <div>
                  <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>{t(`steps.${s.key}.title`)}</div>
                  <div style={{ marginTop: 2, color: "var(--ink-2)", lineHeight: 1.55, fontSize: 14 }}>{t(`steps.${s.key}.body`)}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* What you can do */}
      <section style={{ marginTop: "var(--space-6)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
          {t("onceClaimed")}
        </h2>
        <Card style={{ padding: "var(--space-4)" }}>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: "var(--space-2)" }}>
            {PERK_KEYS.map((k) => (
              <li key={k} style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start", color: "var(--ink-2)", lineHeight: 1.5 }}>
                <Icon name="check" size={15} style={{ color: "var(--crimson-700)" }} />
                {t(`perks.${k}`)}
              </li>
            ))}
          </ul>
        </Card>
        <p style={{ marginTop: "var(--space-3)", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
          {t("publicSourcesNote")}
        </p>
      </section>

      <div style={{ textAlign: "center", marginTop: "var(--space-8)" }}>
        <Link href="/explore" style={{ textDecoration: "none" }}>
          <Button variant="pri">{t("findYourBusiness")}</Button>
        </Link>
      </div>
    </main>
  );
}
