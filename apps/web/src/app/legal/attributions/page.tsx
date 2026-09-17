/**
 * Attributions & credits. Real content (not a placeholder) — the third-party data and open-source
 * credits Roam relies on. Keep in sync as integrations change. Channel-aware (plan Phase 1.3): a
 * branded storefront host gets its own back link and the FSA credit that its venue pages carry.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";
import { getChannelInfo } from "../../../lib/serverApi";

export const metadata: Metadata = { title: "Attributions" };

export default async function AttributionsPage() {
  const channel = await getChannelInfo();
  const branded = !!channel && !channel.isDefault;
  const who = branded ? `${channel!.name} and Roam` : "Roam";
  return (
    <LegalDoc
      title="Attributions"
      lastUpdated="17 September 2026"
      backHref={branded ? "/" : "/settings"}
      backLabel={branded ? channel!.name : "Settings"}
    >
      <p>{who} {branded ? "are" : "is"} built on data and tools from others. We&apos;re grateful to credit them here.</p>

      <h2>Food hygiene ratings</h2>
      <p>
        Food hygiene ratings are published by the <strong>Food Standards Agency</strong> under the
        Food Hygiene Rating Scheme, operated in partnership with local councils. Contains public
        sector information licensed under the{" "}
        <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener noreferrer">
          Open Government Licence v3.0
        </a>
        . Rating images are the FSA&apos;s own and are shown unaltered alongside the rating date. Look
        a rating up at{" "}
        <a href="https://ratings.food.gov.uk/" target="_blank" rel="noopener noreferrer">
          ratings.food.gov.uk
        </a>
        .
      </p>

      <h2>Transit data</h2>
      <p>
        Northern Ireland bus and rail departures are provided by Translink&apos;s open data service.
      </p>
      <p>
        <strong>Transport Information supplied by Translink Opendata API.</strong>
      </p>

      <h2>Places data</h2>
      <p>
        Some venue listings, photos and opening hours are seeded from public sources, including{" "}
        <strong>Google Places</strong>, to give new areas a useful base layer before businesses claim
        and enrich their own listing. This information comes from public sources and may be updated
        or corrected over time. Google is a trademark of Google LLC.
      </p>

      <h2>Payments</h2>
      <p>Card payments are processed by Stripe.</p>

      <h2>Typefaces</h2>
      <p>
        Type is set in Archivo and JetBrains Mono, served via Google Fonts under the SIL Open Font
        License.
      </p>

      <h2>Open-source software</h2>
      <p>
        The platform is built with many open-source projects, including Next.js, React, tRPC,
        Supabase and PostgreSQL. Thank you to the maintainers and communities behind them.
      </p>
    </LegalDoc>
  );
}
