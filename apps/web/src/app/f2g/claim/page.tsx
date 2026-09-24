/**
 * /f2g/claim — RETIRED by F2G plan 2.4, kept as a redirect.
 *
 * This was B3-d's invite→claim landing page: it took a signed capability token and conferred
 * ownership on whoever clicked it while signed in. That made a forwarded email a live credential,
 * which is exactly the bearer-link risk 2.4 closes. Ownership now needs proof of control of the
 * organisation's email address, and that lives at /activate.
 *
 * The route stays because invite emails sent before 2.4 are still in people's inboxes and still
 * carry their token — dropping it would turn every outstanding invite into a 404. The token is
 * forwarded intact; /activate treats it as a hint about which roster row is meant and nothing more,
 * so an old link is now worth exactly as much as a new one, which is to say nothing on its own.
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function F2gClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  redirect(token ? `/activate?token=${encodeURIComponent(token)}` : "/activate");
}
