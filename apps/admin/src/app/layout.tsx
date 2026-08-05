/**
 * Roam HQ root layout. Imports the same generated token stylesheet as apps/web and
 * apps/console (globals.css — the :root vars, fonts, .t-* classes), so the admin surface
 * renders on the identical Foundations design system. This is the internal staff surface,
 * a separate product from both the consumer app and the business console.
 */
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Roam HQ",
  description: "Roam's internal admin dashboard — staff only.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
