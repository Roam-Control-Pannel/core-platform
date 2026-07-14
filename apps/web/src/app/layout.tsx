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
import { LocaleProvider } from "../lib/i18n/LocaleProvider";
import { TopBar } from "../components/TopBar";
import { TabBar } from "../components/TabBar";
import { CreateFab } from "../components/CreateFab";
import { FirstRunProfilePrompt } from "../components/FirstRunProfilePrompt";
import { LocationGate } from "../components/LocationGate";
import { PlacePrefsSync } from "../components/PlacePrefsSync";
import { siteUrl, ogCardUrl } from "../lib/seo";

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

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "Roam — hyper-local discovery & social planning", template: "%s · Roam" },
  description: DESCRIPTION,
  applicationName: "Roam",
  icons: { icon: "/roam-mark.png" },
  // Emitted only when GOOGLE_SITE_VERIFICATION is set (the HTML-tag verification route; a DNS
  // "Domain" property in Search Console needs nothing here).
  ...(googleVerification ? { verification: { google: googleVerification } } : {}),
  openGraph: {
    type: "website",
    siteName: "Roam",
    title: "Roam — hyper-local discovery & social planning",
    description: DESCRIPTION,
    images: [{ url: DEFAULT_CARD }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Roam — hyper-local discovery & social planning",
    description: DESCRIPTION,
    images: [DEFAULT_CARD],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // lang="en" is the SERVER truth — the server always renders English (client-first i18n; see
  // lib/i18n/runtime.ts). LocaleProvider updates the attribute client-side when a user has
  // picked another language. Deliberately NO cookie read here: that would force every route
  // dynamic and foreclose static caching, for chrome that is client-rendered anyway.
  return (
    <html lang="en">
      <body>
        <LocaleProvider>
          <TrpcProvider>
            <TopBar />
            {children}
            <CreateFab />
            <TabBar />
            <FirstRunProfilePrompt />
            {/* First-visit location: IP default for fresh signed-out visitors + precise-location card. */}
            <LocationGate />
            {/* Headless: syncs saved/current place to the account (cross-device). */}
            <PlacePrefsSync />
          </TrpcProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
