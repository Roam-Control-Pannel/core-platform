/**
 * Analytics — Google Analytics 4 (gtag.js), loaded once from the root layout, ONLY after consent.
 *
 * The GA4 Measurement ID is public by design (it ships in the page HTML on every site that uses
 * GA), so it's a safe in-repo default; `NEXT_PUBLIC_GA_ID` can override it per-environment (e.g. a
 * separate property for staging). Set the id to empty to disable analytics entirely.
 *
 * Consent (holistic plan Phase 1.3): nothing is injected until the visitor has granted analytics
 * consent via the ConsentBanner (lib/consent.ts). "Denied" or "not yet asked" = no tag, no cookies,
 * no request to Google. A grant made on this page load mounts the tag immediately (no reload).
 *
 * `afterInteractive` loads the tag after hydration so it never blocks first paint. GA4's built-in
 * enhanced measurement tracks client-side route changes (browser history events), so the single
 * `config` call here covers App Router navigations without a per-route pageview hook.
 */
"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { onConsentChange, readConsent } from "../lib/consent";

const GA_ID = process.env.NEXT_PUBLIC_GA_ID ?? "G-J4ZSWS4B6R";

export function Analytics() {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    setGranted(readConsent() === "granted");
    return onConsentChange((choice) => setGranted(choice === "granted"));
  }, []);

  if (!GA_ID || !granted) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
      </Script>
    </>
  );
}
