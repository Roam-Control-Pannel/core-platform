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
import "./globals.css";
import { TrpcProvider } from "../components/TrpcProvider";
import { TopBar } from "../components/TopBar";
import { TabBar } from "../components/TabBar";
import { CreateFab } from "../components/CreateFab";

export const metadata = {
  title: "Roam",
  description: "Hyper-local discovery + social planning.",
  icons: { icon: "/roam-mark.png" },
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
