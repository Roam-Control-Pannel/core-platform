/**
 * Stripe client — the lean, fetch-based boundary to Stripe's REST API, following the same
 * pattern as the Places/Awin/Brevo clients (no SDK: a handful of endpoints, form-encoded
 * requests, explicit types for exactly the fields we read). Server-only: the secret key
 * never leaves the API service.
 *
 * PR 1 scope (Connect payout onboarding):
 *   - createExpressAccount    — one Express connected account per venue (Stripe hosts ALL
 *                               KYC/banking onboarding; we store only the account id).
 *   - createOnboardingLink    — a short-lived hosted-onboarding URL to send the owner to.
 *   - getAccount              — the three status flags the dashboard shows.
 *   - verifyStripeSignature   — webhook authenticity (pure HMAC check, unit-tested; no SDK).
 *
 * Checkout / payments arrive in the next marketplace slice on this same client.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface StripeConfig {
  secretKey: string;
  /** Overridable for tests; never in production. */
  baseUrl?: string;
}

const STRIPE_API = "https://api.stripe.com";

/**
 * Flatten a params object into Stripe's form encoding — nested objects/arrays become
 * bracket notation (capabilities[transfers][requested]=true, items[0][price]=...).
 * Null/undefined values are omitted. Exported for tests.
 */
export function encodeForm(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (key: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(`${key}[${k}]`, v);
      }
      return;
    }
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return pairs.join("&");
}

/** One Stripe REST call. Throws with Stripe's own error message on a non-2xx. */
async function stripeRequest<T>(
  cfg: StripeConfig,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const base = cfg.baseUrl ?? STRIPE_API;
  const body = method === "POST" && params ? encodeForm(params) : undefined;
  const url = method === "GET" && params ? `${base}${path}?${encodeForm(params)}` : `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      // Pin the API version we developed against so Stripe-side upgrades never change
      // response shapes under us silently.
      "Stripe-Version": "2024-06-20",
    },
    ...(body !== undefined ? { body } : {}),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !json) {
    const message = json?.error?.message ?? `Stripe ${path} failed with ${res.status}`;
    throw new Error(message);
  }
  return json;
}

/** The connected-account status flags the dashboard cares about. */
export interface StripeAccountStatus {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}

/**
 * Create an Express connected account for a venue. Country is fixed at creation
 * (GB default; IE and others supported as the platform expands). The email pre-fills
 * Stripe's onboarding; card_payments + transfers are the marketplace capabilities.
 */
export async function createExpressAccount(
  cfg: StripeConfig,
  input: { country: string; email?: string | undefined },
): Promise<{ id: string }> {
  return stripeRequest(cfg, "POST", "/v1/accounts", {
    type: "express",
    country: input.country,
    email: input.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
}

/** A short-lived hosted-onboarding URL for the given connected account. */
export async function createOnboardingLink(
  cfg: StripeConfig,
  input: { account: string; refreshUrl: string; returnUrl: string },
): Promise<{ url: string }> {
  return stripeRequest(cfg, "POST", "/v1/account_links", {
    account: input.account,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: "account_onboarding",
  });
}

/** Read a connected account's live status flags. */
export async function getAccount(cfg: StripeConfig, accountId: string): Promise<StripeAccountStatus> {
  return stripeRequest(cfg, "GET", `/v1/accounts/${encodeURIComponent(accountId)}`);
}

/** A one-time login URL into the venue's Express dashboard (payouts, bank details). */
export async function createLoginLink(cfg: StripeConfig, accountId: string): Promise<{ url: string }> {
  return stripeRequest(cfg, "POST", `/v1/accounts/${encodeURIComponent(accountId)}/login_links`);
}

/**
 * Create a hosted Checkout session for a marketplace sale: a DESTINATION charge — the buyer
 * pays on the platform, funds route to the venue's connected account, and Roam's commission
 * is taken as the application fee. Ad-hoc price_data (our DB is the catalogue; no Stripe
 * Products). Metadata carries the order id so the webhook can mark it paid.
 */
export async function createCheckoutSession(
  cfg: StripeConfig,
  input: {
    destinationAccount: string;
    applicationFeePence: number;
    title: string;
    unitAmountPence: number;
    currency: string;
    quantity: number;
    orderId: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ id: string; url: string }> {
  return stripeRequest(cfg, "POST", "/v1/checkout/sessions", {
    mode: "payment",
    line_items: [
      {
        quantity: input.quantity,
        price_data: {
          currency: input.currency,
          unit_amount: input.unitAmountPence,
          product_data: { name: input.title },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: input.applicationFeePence,
      transfer_data: { destination: input.destinationAccount },
    },
    metadata: { order_id: input.orderId },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
}

/**
 * Refund a marketplace payment in full: pull the funds back from the connected account
 * (reverse_transfer) and return Roam's commission too (refund_application_fee) — the buyer
 * is made whole; Stripe's processing fee is the platform's cost of the refund.
 */
export async function refundPayment(
  cfg: StripeConfig,
  input: { paymentIntent: string },
): Promise<{ id: string; status: string }> {
  return stripeRequest(cfg, "POST", "/v1/refunds", {
    payment_intent: input.paymentIntent,
    reverse_transfer: true,
    refund_application_fee: true,
  });
}

/**
 * Verify a Stripe webhook signature (the Stripe-Signature header: `t=<ts>,v1=<hmac>,...`).
 * The v1 scheme is HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret. Pure —
 * `nowMs` is injectable so the timestamp-tolerance check is unit-testable.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  endpointSecret: string,
  nowMs: number,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader) return false;
  let timestamp: string | null = null;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=", 2);
    if (!k || !v) continue;
    if (k.trim() === "t") timestamp = v.trim();
    if (k.trim() === "v1") candidates.push(v.trim());
  }
  if (!timestamp || candidates.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;

  const expected = createHmac("sha256", endpointSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return candidates.some((c) => {
    const buf = Buffer.from(c, "utf8");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
}
