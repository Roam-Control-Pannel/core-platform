/**
 * Root layout. Imports the generated token stylesheet (globals.css — the :root vars,
 * the three Google Fonts, the .t-* type classes, base body), so every page renders on
 * the Foundations design system. This is where the single-source tokens become live CSS.
 */
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Roam",
  description: "Hyper-local discovery + social planning.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
