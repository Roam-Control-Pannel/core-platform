/**
 * LegalDoc — the shared chrome for a legal / policy document (Terms, Privacy, Subscription,
 * Community Guidelines, Attributions). A plain server component: a titled, readable column with a
 * back link and optional "last updated" stamp. The document COPY lives in each route's page file
 * so the final text can be dropped in without touching this layout.
 *
 * `draft` renders a visible placeholder note — set it on a page whose copy is still a stub, and
 * remove it once the real text is in. Legal pages are intentionally public (reachable signed-out;
 * app stores and sign-up flows link to them directly).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./LegalDoc.module.css";

export function LegalDoc({
  title,
  lastUpdated,
  draft,
  children,
}: {
  title: string;
  lastUpdated?: string;
  draft?: boolean;
  children: ReactNode;
}) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ padding: "var(--space-2) 0 var(--space-4)" }}>
        <Link
          href="/settings"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}
        >
          <span aria-hidden>←</span> Settings
        </Link>
        <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: "var(--space-3) 0 0", fontSize: 26 }}>
          {title}
        </h1>
        {lastUpdated ? (
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--faint)" }}>Last updated {lastUpdated}</p>
        ) : null}
      </header>

      {draft ? (
        <div
          role="note"
          style={{
            display: "flex",
            gap: 8,
            padding: "10px 14px",
            marginBottom: "var(--space-4)",
            borderRadius: 12,
            border: "1px solid var(--gold, #caa24a)",
            background: "rgba(202, 162, 74, 0.12)",
            fontSize: 13,
            color: "var(--ink-2)",
          }}
        >
          <span aria-hidden>✎</span>
          <span>
            This is placeholder copy — the final {title} will replace it before launch.
          </span>
        </div>
      ) : null}

      <article className={styles.prose}>{children}</article>
    </main>
  );
}
