/**
 * Translink ticketing hand-off.
 *
 * Translink's fares/tickets are NOT in the open Public Transport API we integrate — prices and
 * purchase live in their separate **mLink** app (confirmed by Phase-0 recon). So Roam can't show a
 * £ price or sell a ticket in-app; the honest, useful action is a hand-off to mLink.
 *
 * TODO(mlink-deeplink): this is the public landing page for the app — the safe default that always
 * resolves. If Translink confirms a route/ticket deep-link (or a universal link that opens the app
 * on a specific fare), swap MLINK_URL / extend mlinkTicketUrl to pass it through. Kept in one place
 * so that upgrade is a one-line change.
 */

/** Where "Buy a ticket" sends the user until a real deep-link is confirmed. */
export const MLINK_URL = "https://www.translink.co.uk/usingourservicesandproducts/ourapps/mlink-ticketing-app";

/** The ticketing URL for a departure/journey. Currently context-free (the mLink landing page). */
export function mlinkTicketUrl(): string {
  return MLINK_URL;
}
