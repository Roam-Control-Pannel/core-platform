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
import type { Metadata } from "next";
import "./globals.css";
import { TrpcProvider } from "../components/TrpcProvider";
import { TopBar } from "../components/TopBar";
import { TabBar } from "../components/TabBar";
import { CreateFab } from "../components/CreateFab";
import { siteUrl } from "../lib/seo";

const DESCRIPTION = "Discover the best local venues, read reviews, follow your town's news and plan days out with friends — all on Roam.";

/**
 * Root metadata + the defaults every page inherits. `metadataBase` makes relative Open Graph
 * image URLs absolute; the title `template` gives each page a "<Page> · Roam" title while
 * `default` covers routes without their own generateMetadata. Per-page generateMetadata
 * (venue/profile/post/topic) overrides title, description, canonical and the share card.
 */
const googleVerification = process.env.GOOGLE_SITE_VERIFICATION;

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
    images: [{ url: "/roam-mark.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Roam — hyper-local discovery & social planning",
    description: DESCRIPTION,
    images: ["/roam-mark.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TrpcProvider>
          <TopBar />
          {children}
          <CreateFab />
          <TabBar />
        </TrpcProvider>
      </body>
    </html>
  );
}
