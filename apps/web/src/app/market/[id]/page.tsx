/** Listing detail route — /market/[id]. Next 16: the param arrives as a Promise. */
export const dynamic = "force-dynamic";

import { ListingDetail } from "../../../components/ListingDetail";

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingDetail listingId={id} />;
}
