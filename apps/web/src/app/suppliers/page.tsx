/**
 * /suppliers — the F2G supplier directory (C3-b). A live, channel-scoped list (only live+approved
 * suppliers), so it's noindex here; individual suppliers get their own /suppliers/[slug] page. Public
 * to read; adding a business auths just-in-time and is gated on live membership.
 */
import type { Metadata } from "next";
import { Suppliers } from "../../components/Suppliers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Suppliers",
  robots: { index: false, follow: true },
};

export default function SuppliersPage() {
  return <Suppliers />;
}
