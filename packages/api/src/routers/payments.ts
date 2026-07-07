/**
 * Payments router — Stripe Connect payout onboarding for claimed venues (marketplace PR 1).
 *
 * Every procedure is owner-gated in code (verify the caller owns the venue) BEFORE touching
 * Stripe, and account rows are written with the service client (the sanctioned in-process
 * escalation — clients have no write policies on venue_payment_accounts by design).
 *
 *   - accountStatus       : the dashboard's payout card state (configured? connected? enabled?).
 *   - createOnboardingLink: create the Express account on first use, then mint a fresh hosted-
 *                           onboarding URL (Stripe link URLs are short-lived — always minted on
 *                           demand, never stored).
 *   - refreshStatus       : pull the live flags from Stripe and sync our cache — called when
 *                           the owner returns from Stripe onboarding (the account.updated
 *                           webhook covers changes made while nobody's looking).
 *
 * Dormant-by-default: with no STRIPE_SECRET_KEY configured, accountStatus reports
 * configured:false (the card renders a quiet "coming soon") and the mutations refuse cleanly.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, escalateToService } from "../trpc.js";
import {
  createExpressAccount,
  createOnboardingLink,
  getAccount,
  type StripeConfig,
} from "../stripe/client.js";

interface AccountRow {
  venue_id: string;
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  country: string;
}

/** The status shape the dashboard card renders. */
export interface PayoutStatus {
  configured: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

type LooseDb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Resolve the signed-in caller and verify they own this venue; returns their user id. */
async function requireVenueOwner(
  ctx: { db: unknown },
  venueId: string,
): Promise<string> {
  const db = ctx.db as LooseDb & {
    auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  };
  const { data: auth, error: authError } = await db.auth.getUser();
  if (authError || !auth.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  const { data, error } = (await db
    .from("venues")
    .select("id, owner_id, status")
    .eq("id", venueId)
    .maybeSingle()) as { data: { owner_id: string | null; status: string } | null; error: { message: string } | null };
  if (error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load venue: ${error.message}` });
  }
  if (!data || data.owner_id !== auth.user.id || data.status !== "claimed") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue's owner can manage payments." });
  }
  return auth.user.id;
}

function stripeConfig(env: { stripe: { secretKey: string | null } }): StripeConfig {
  if (!env.stripe.secretKey) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Payments aren't configured on this environment yet." });
  }
  return { secretKey: env.stripe.secretKey };
}

/** Read a venue's account row with the service client (no client write/read coupling). */
async function readAccountRow(service: unknown, venueId: string): Promise<AccountRow | null> {
  const { data } = (await (service as LooseDb)
    .from("venue_payment_accounts")
    .select("venue_id, stripe_account_id, charges_enabled, payouts_enabled, details_submitted, country")
    .eq("venue_id", venueId)
    .maybeSingle()) as { data: AccountRow | null };
  return data ?? null;
}

function toStatus(configured: boolean, row: AccountRow | null): PayoutStatus {
  return {
    configured,
    connected: !!row,
    chargesEnabled: row?.charges_enabled ?? false,
    payoutsEnabled: row?.payouts_enabled ?? false,
    detailsSubmitted: row?.details_submitted ?? false,
  };
}

export const paymentsRouter = router({
  /** Owner: the payout-onboarding state for the dashboard card. */
  accountStatus: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<PayoutStatus> => {
      await requireVenueOwner(ctx, input.venueId);
      const configured = !!ctx.env.stripe.secretKey;
      if (!configured) return toStatus(false, null);
      const service = escalateToService(ctx.env);
      const row = await readAccountRow(service, input.venueId);
      return toStatus(true, row);
    }),

  /**
   * Owner: start (or resume) Stripe's hosted payout onboarding. Creates the Express account
   * on first call — country defaults to GB (per-venue country support widens later) — then
   * returns a fresh short-lived onboarding URL to redirect the owner to.
   */
  createOnboardingLink: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ url: string }> => {
      await requireVenueOwner(ctx, input.venueId);
      const cfg = stripeConfig(ctx.env);
      const service = escalateToService(ctx.env);

      let row = await readAccountRow(service, input.venueId);
      if (!row) {
        const account = await createExpressAccount(cfg, { country: "GB", email: undefined });
        const { error } = (await (service as unknown as LooseDb)
          .from("venue_payment_accounts")
          .insert({ venue_id: input.venueId, stripe_account_id: account.id, country: "GB" })
          .select("venue_id")) as { error: { message: string } | null };
        if (error) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to save the payment account: ${error.message}` });
        }
        row = await readAccountRow(service, input.venueId);
      }
      if (!row) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Payment account row missing after create." });
      }

      const base = ctx.env.stripe.webOrigin.replace(/\/$/, "");
      const link = await createOnboardingLink(cfg, {
        account: row.stripe_account_id,
        refreshUrl: `${base}/dashboard/${input.venueId}?payments=refresh`,
        returnUrl: `${base}/dashboard/${input.venueId}?payments=return`,
      });
      return { url: link.url };
    }),

  /**
   * Owner: sync our cached flags from Stripe's live account state — called when the owner
   * lands back from hosted onboarding (webhooks cover the rest of the time).
   */
  refreshStatus: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<PayoutStatus> => {
      await requireVenueOwner(ctx, input.venueId);
      const configured = !!ctx.env.stripe.secretKey;
      if (!configured) return toStatus(false, null);
      const service = escalateToService(ctx.env);
      const row = await readAccountRow(service, input.venueId);
      if (!row) return toStatus(true, null);

      const account = await getAccount(stripeConfig(ctx.env), row.stripe_account_id);
      const { error } = (await (service as unknown as LooseDb)
        .from("venue_payment_accounts")
        .update({
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          details_submitted: account.details_submitted,
        })
        .eq("venue_id", input.venueId)
        .select("venue_id")) as { error: { message: string } | null };
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to sync payment status: ${error.message}` });
      }
      return {
        configured: true,
        connected: true,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      };
    }),
});
