/**
 * Attributions & credits. Real content (not a placeholder) — the third-party data and open-source
 * credits Roam relies on. Keep in sync as integrations change.
 */
import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";

export const metadata: Metadata = { title: "Attributions" };

export default function AttributionsPage() {
  return (
    <LegalDoc title="Attributions" lastUpdated="1 July 2026">
      <p>Roam is built on data and tools from others. We&apos;re grateful to credit them here.</p>

      <h2>Transit data</h2>
      <p>
        Northern Ireland bus and rail departures are provided by Translink&apos;s open data service.
      </p>
      <p>
        <strong>Transport Information supplied by Translink Opendata API.</strong>
      </p>

      <h2>Places data</h2>
      <p>
        Some venue listings are seeded from public sources, including Google Places, to give new
        areas a useful base layer before businesses claim and enrich their own listing. This
        information comes from public sources and may be updated or corrected over time.
      </p>

      <h2>Typefaces</h2>
      <p>
        Roam&apos;s type is set in Space Grotesk, Schibsted Grotesk and Space Mono, served via Google
        Fonts under the SIL Open Font License.
      </p>

      <h2>Open-source software</h2>
      <p>
        Roam is built with many open-source projects, including Next.js, React, tRPC, Supabase and
        PostgreSQL. Thank you to the maintainers and communities behind them.
      </p>
    </LegalDoc>
  );
}
