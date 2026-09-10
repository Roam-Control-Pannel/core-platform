/**
 * Root layout. Imports the generated token stylesheet (globals.css — the :root vars,
 * the three Google Fonts, the .t-* type classes, base body), so every page renders on
 * the Foundations design system. This is where the single-source tokens become live CSS.
 *
 * It also mounts the app SHELL once, around every page:
 *   - TrpcProvider — the typed, session-bound client. Lifted here from the individual
 *     pages so there is ONE session source for the whole app (the chrome below needs it
 *     too), instead of a provider per route. Pages render their components directly.
 *   - TopBar — the global brand + primary nav (Explore · Plans · Chat · You) + sign-in.
 *   - TabBar — the mobile bottom tab bar (phones only; hidden on desktop).
 */
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TrpcProvider } from "../components/TrpcProvider";
import { ChannelProvider } from "../components/ChannelProvider";
import { LocaleProvider } from "../lib/i18n/LocaleProvider";
import { TopBar } from "../components/TopBar";
import { TabBar } from "../components/TabBar";
import { CreateFab } from "../components/CreateFab";
import { SideNav, SideNavProvider } from "../components/SideNav";
import { MeProvider } from "../components/MeProvider";
import sideNav from "../components/SideNav.module.css";
import { FirstRunProfilePrompt } from "../components/FirstRunProfilePrompt";
import { InviteApply } from "../components/InviteApply";
import { LocationGate } from "../components/LocationGate";
import { PlacePrefsSync } from "../components/PlacePrefsSync";
import { Analytics } from "../components/Analytics";
import { siteUrl, ogCardUrl } from "../lib/seo";
import { getChannelInfo } from "../lib/serverApi";

const DESCRIPTION = "Discover the best local venues, read reviews, follow your town's news and plan days out with friends — all on Roam.";

// The site-default share card: the generated 1200×630 (app/og/route.tsx), not the square mark.
const DEFAULT_CARD = ogCardUrl({ title: "Your town, together", subtitle: "Local places, news, plans and people — all on Roam." });

/**
 * Root metadata + the defaults every page inherits. `metadataBase` makes relative Open Graph
 * image URLs absolute; the title `template` gives each page a "<Page> · Roam" title while
 * `default` covers routes without their own generateMetadata. Per-page generateMetadata
 * (venue/profile/post/topic) overrides title, description, canonical and the share card.
 */
const googleVerification = process.env.GOOGLE_SITE_VERIFICATION;

/**
 * Viewport config. Next injects a default `width=device-width, initial-scale=1`, but WITHOUT
 * `viewport-fit=cover` — and the chrome (TabBar, CreateFab) pads itself with
 * `env(safe-area-inset-bottom)`, which only resolves to a non-zero value under `cover`. Without
 * this the bottom tab bar collides with the home indicator on notched iPhones. `themeColor`
 * matches --paper so the mobile browser UI blends with the page.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F6F3EF",
};

const ROAM_TITLE = "Roam — hyper-local discovery & social planning";

/**
 * Root metadata + the defaults every page inherits, resolved PER CHANNEL (review debt D2).
 *
 * This is now `generateMetadata` (was a static `metadata`) so a branded host renders its own
 * brand server-side: `nifood2go.roam-local.com` gets the NI Food to Go Association title, OG,
 * siteName, favicon and the `%s · <brand>` template, instead of Roam's. The channel is read from
 * `x-roam-channel` (set by middleware) via getChannelInfo → the channel-aware server tRPC client.
 *
 * TRADEOFF (a deliberate, approved reversal of the earlier "no request-read here, stay static"
 * choice): reading the channel per request opts routes that inherit this default into dynamic
 * rendering. That is inherent to correct per-tenant SEO — a per-host title cannot be baked at
 * build time — and was chosen over shipping 5,000 mis-branded member pages. The default channel
 * (roam) and any unresolved read fall back to exactly the previous Roam metadata, unchanged.
 *
 * NOT YET per-channel (deferred to A3-b): `metadataBase`/canonical HOST (needs the custom-domain
 * decision) and the OG card ART (the /og route stays Roam-styled; only its TEXT is channel-aware).
 */
const googleVerificationMeta = googleVerification
  ? { verification: { google: googleVerification } }
  : {};

export async function generateMetadata(): Promise<Metadata> {
  const resolved = await getChannelInfo();
  // The branded channel for this host, or null on the default (roam) channel / an unresolved read
  // — null keeps the exact previous Roam metadata. A local (not a derived boolean) so TS narrows.
  const c = resolved && !resolved.isDefault ? resolved : null;
  const brand = c ? c.name : "Roam";
  const defaultTitle = c ? (c.tagline ? `${c.name} — ${c.tagline}` : c.name) : ROAM_TITLE;
  const description = c && c.tagline ? c.tagline : DESCRIPTION;
  // Keep the generated 1200×630 card (its art is channelised in A3-b); use the channel's copy.
  const card = c ? ogCardUrl({ title: c.name, subtitle: c.tagline ?? description }) : DEFAULT_CARD;
  return {
    // metadataBase stays the Roam origin for now — per-channel canonical host is A3-b.
    metadataBase: new URL(siteUrl()),
    title: { default: defaultTitle, template: `%s · ${brand}` },
    description,
    applicationName: brand,
    icons: { icon: c && c.logoUrl ? c.logoUrl : "/roam-mark.png" },
    ...googleVerificationMeta,
    openGraph: {
      type: "website",
      siteName: brand,
      title: defaultTitle,
      description,
      images: [{ url: card }],
    },
    twitter: {
      card: "summary_large_image",
      title: defaultTitle,
      description,
      images: [card],
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  // lang="en" is the SERVER truth — the server always renders English (client-first i18n; see
  // lib/i18n/runtime.ts). LocaleProvider updates the attribute client-side when a user has
  // picked another language. Deliberately NO cookie read here: that would force every route
  // dynamic and foreclose static caching, for chrome that is client-rendered anyway.
  return (
    <html lang="en">
      <body>
        {/* Google Analytics (GA4) — loaded after hydration; never blocks first paint. */}
        <Analytics />
        <LocaleProvider>
          <TrpcProvider>
            {/* Publishes the active channel (Food to Go vs Roam) + applies its palette. */}
            <ChannelProvider>
            <MeProvider>
            <SideNavProvider>
              <TopBar />
              <SideNav />
              <div className={sideNav.content}>{children}</div>
            </SideNavProvider>
            <CreateFab />
            <TabBar />
            <FirstRunProfilePrompt />
            {/* Invite loop: connect a new user to whoever's /i/<handle> link brought them in. */}
            <InviteApply />
            {/* First-visit location: IP default for fresh signed-out visitors + precise-location card. */}
            <LocationGate />
            {/* Headless: syncs saved/current place to the account (cross-device). */}
            <PlacePrefsSync />
            </MeProvider>
            </ChannelProvider>
          </TrpcProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
