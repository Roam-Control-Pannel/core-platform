/**
 * /suppliers/[slug] — one supplier's public page (C3-b). Client-fetched via suppliers.bySlug; force-
 * dynamic since visibility depends on the caller (public sees live+approved, the owner sees their own).
 */
import type { Metadata } from "next";
import { SupplierDetail } from "../../../components/SupplierDetail";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Supplier",
  robots: { index: false, follow: true },
};

export default async function SupplierPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <SupplierDetail slug={slug} />;
}
