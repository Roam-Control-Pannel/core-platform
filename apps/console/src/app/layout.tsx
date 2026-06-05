/**
 * Console root layout. Imports the same generated token stylesheet as apps/web
 * (globals.css — the :root vars, fonts, .t-* classes), so the business console
 * renders on the identical Foundations design system. Distinct metadata: this is
 * the business surface, a separate product from the consumer app.
 */
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Roam for Business",
  description: "Manage your venue on Roam — posts, insights, and more.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
