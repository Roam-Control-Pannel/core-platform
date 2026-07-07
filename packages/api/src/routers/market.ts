/**
 * Market router — the venue shop's catalogue (marketplace PR 2).
 *
 * Plain RLS-backed CRUD: reads and writes run under the CALLER's client, so the 0070
 * policies are the security boundary (public sees active products; only the claimed
 * venue's owner writes — no service escalation anywhere in this router). Checkout and
 * orders arrive in the next slice; until then the public shop renders the catalogue
 * with a "buying opens soon" note.
 *
 * Prices are integer PENCE end-to-end. The client renders them; nothing here does
 * float arithmetic on money.
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import { createCheckoutSession, refundPayment } from "../stripe/client.js";

/** The catalogue-entry shape both surfaces render. */
export interface MarketProduct {
  id: string;
  venueId: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  pricePence: number;
  currency: string;
  stock: number | null;
  photoUrl: string | null;
  active: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  venue_id: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  price_pence: number;
  currency: string;
  stock: number | null;
  photo_url: string | null;
  active: boolean;
  created_at: string;
}

const COLS = "id, venue_id, kind, title, description, price_pence, currency, stock, photo_url, active, created_at";

function shape(r: Row): MarketProduct {
  return {
    id: r.id,
    venueId: r.venue_id,
    kind: r.kind,
    title: r.title,
    description: r.description,
    pricePence: r.price_pence,
    currency: r.currency,
    stock: r.stock,
    photoUrl: r.photo_url,
    active: r.active,
    createdAt: r.created_at,
  };
}

type LooseDb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const productFields = {
  kind: z.enum(["product", "service"]),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).nullish(),
  pricePence: z.number().int().min(50).max(5_000_000),
  stock: z.number().int().min(0).max(100_000).nullish(),
  photoUrl: z.string().trim().url().max(600).nullish(),
};

/** Load an order and verify the CALLER owns its venue (buyer readability isn't enough for
 *  owner actions). Returns the row + a service client for the state write. */
async function ownedOrder(
  ctx: { db: unknown; env: Parameters<typeof escalateToService>[0] },
  orderId: string,
): Promise<{
  order: { id: string; venue_id: string; product_kind: string; status: string; stripe_payment_intent_id: string | null; buyer_id: string | null; product_title: string; amount_pence: number };
  service: LooseDb;
}> {
  const { data: auth } = await (ctx.db as { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } }).auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new TRPCError({ code: "UNAUTHORIZED" });
  const service = escalateToService(ctx.env) as unknown as LooseDb;
  const { data: order } = (await service
    .from("orders")
    .select("id, venue_id, product_kind, status, stripe_payment_intent_id, buyer_id, product_title, amount_pence")
    .eq("id", orderId)
    .maybeSingle()) as { data: { id: string; venue_id: string; product_kind: string; status: string; stripe_payment_intent_id: string | null; buyer_id: string | null; product_title: string; amount_pence: number } | null };
  if (!order) throw new TRPCError({ code: "NOT_FOUND" });
  const { data: venue } = (await service
    .from("venues")
    .select("owner_id")
    .eq("id", order.venue_id)
    .maybeSingle()) as { data: { owner_id: string | null } | null };
  if (venue?.owner_id !== uid) throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue's owner can manage its orders." });
  return { order, service };
}

export const marketRouter = router({
  /** Public: a venue's live catalogue (active products, newest first) + whether the venue
   *  can take online payments right now ("is there a Buy button" is public information). */
  listByVenue: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<{ sellable: boolean; products: MarketProduct[] }> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .select(COLS)
        .eq("venue_id", input.venueId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(100)) as { data: Row[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load the shop: ${error.message}` });
      let sellable = false;
      if (ctx.env.stripe.secretKey) {
        const service = escalateToService(ctx.env) as unknown as LooseDb;
        const { data: acct } = (await service
          .from("venue_payment_accounts")
          .select("charges_enabled")
          .eq("venue_id", input.venueId)
          .maybeSingle()) as { data: { charges_enabled: boolean } | null };
        sellable = !!acct?.charges_enabled;
      }
      return { sellable, products: (data ?? []).map(shape) };
    }),

  /** Owner: the full catalogue including deactivated entries (RLS scopes the extra rows). */
  mine: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<MarketProduct[]> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .select(COLS)
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(200)) as { data: Row[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your products: ${error.message}` });
      return (data ?? []).map(shape);
    }),

  /** Owner: add a product or service. RLS (owner + claimed) is the gate; a refusal reads
   *  as zero rows via the .select() guard. */
  create: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), ...productFields }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean; product?: MarketProduct }> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .insert({
          venue_id: input.venueId,
          kind: input.kind,
          title: input.title,
          description: input.description ?? null,
          price_pence: input.pricePence,
          currency: "gbp",
          stock: input.stock ?? null,
          photo_url: input.photoUrl ?? null,
        })
        .select(COLS)) as { data: Row[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't add that: ${error.message}` });
      const row = data?.[0];
      return row ? { ok: true, product: shape(row) } : { ok: false };
    }),

  /** Owner: edit an entry (any subset of fields, plus activate/deactivate). */
  update: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        title: productFields.title.optional(),
        description: productFields.description,
        pricePence: productFields.pricePence.optional(),
        stock: productFields.stock,
        photoUrl: productFields.photoUrl,
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.pricePence !== undefined) patch.price_pence = input.pricePence;
      if (input.stock !== undefined) patch.stock = input.stock;
      if (input.photoUrl !== undefined) patch.photo_url = input.photoUrl;
      if (input.active !== undefined) patch.active = input.active;
      if (Object.keys(patch).length === 0) return { ok: true };

      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .update(patch)
        .eq("id", input.productId)
        .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't save that: ${error.message}` });
      return { ok: !!data && data.length > 0 };
    }),

  /**
   * Signed-in buyer: start a checkout for one catalogue entry. Verifies the product is live
   * and in stock and the venue can take payments, snapshots the sale into an orders row
   * (pending; service write — clients never write orders), mints a redeem code for services,
   * then returns Stripe's hosted-checkout URL. The 5%-default platform fee rides as the
   * application fee on the destination charge. `referrerId` is the affiliate seam: captured
   * verbatim now, rewards later.
   */
  checkout: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(20).default(1),
        referrerId: z.string().uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ url: string }> => {
      if (!ctx.env.stripe.secretKey) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Payments aren't configured on this environment yet." });
      }
      const { data: auth } = await (ctx.db as unknown as { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } }).auth.getUser();
      const buyerId = auth.user?.id;
      if (!buyerId) throw new TRPCError({ code: "UNAUTHORIZED" });

      const service = escalateToService(ctx.env) as unknown as LooseDb;
      const { data: prod } = (await service
        .from("venue_products")
        .select(COLS)
        .eq("id", input.productId)
        .eq("active", true)
        .maybeSingle()) as { data: Row | null };
      if (!prod) throw new TRPCError({ code: "NOT_FOUND", message: "That item is no longer available." });
      if (prod.stock != null && prod.stock < input.quantity) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: prod.stock === 0 ? "Sold out." : `Only ${prod.stock} left.` });
      }
      const { data: acct } = (await service
        .from("venue_payment_accounts")
        .select("stripe_account_id, charges_enabled")
        .eq("venue_id", prod.venue_id)
        .maybeSingle()) as { data: { stripe_account_id: string; charges_enabled: boolean } | null };
      if (!acct?.charges_enabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This venue isn't taking online payments yet." });
      }

      const amount = prod.price_pence * input.quantity;
      const fee = Math.round((amount * ctx.env.stripe.applicationFeeBps) / 10_000);
      const redeemCode = prod.kind === "service" ? randomBytes(5).toString("hex").toUpperCase() : null;

      const { data: created, error: orderErr } = (await service
        .from("orders")
        .insert({
          venue_id: prod.venue_id,
          buyer_id: buyerId,
          product_id: prod.id,
          product_title: prod.title,
          product_kind: prod.kind,
          quantity: input.quantity,
          amount_pence: amount,
          application_fee_pence: fee,
          currency: prod.currency,
          redeem_code: redeemCode,
          referrer_profile_id: input.referrerId ?? null,
        })
        .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };
      const order = created?.[0];
      if (orderErr || !order) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't start checkout: ${orderErr?.message ?? "order not created"}` });
      }

      const base = ctx.env.stripe.webOrigin.replace(/\/$/, "");
      const session = await createCheckoutSession({ secretKey: ctx.env.stripe.secretKey }, {
        destinationAccount: acct.stripe_account_id,
        applicationFeePence: fee,
        title: prod.title,
        unitAmountPence: prod.price_pence,
        currency: prod.currency,
        quantity: input.quantity,
        orderId: order.id,
        successUrl: `${base}/orders?placed=${order.id}`,
        cancelUrl: `${base}/orders?canceled=${order.id}`,
      });
      await service.from("orders").update({ stripe_checkout_session_id: session.id }).eq("id", order.id);
      return { url: session.url };
    }),

  /** Buyer: my orders, newest first (RLS: buyer_id = auth.uid()). Redeem codes surface
   *  only once paid — a pending order shows none. */
  myOrders: protectedProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("orders")
      .select("id, venue_id, product_title, product_kind, quantity, amount_pence, currency, status, redeem_code, created_at, venues(name, locality)")
      .order("created_at", { ascending: false })
      .limit(100)) as {
      data:
        | { id: string; venue_id: string; product_title: string; product_kind: string; quantity: number; amount_pence: number; currency: string; status: string; redeem_code: string | null; created_at: string; venues: { name: string; locality: string | null } | { name: string; locality: string | null }[] | null }[]
        | null;
      error: { message: string } | null;
    };
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your orders: ${error.message}` });
    const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
    return (data ?? []).map((r) => ({
      id: r.id,
      venueId: r.venue_id,
      venueName: one(r.venues)?.name ?? "A venue",
      venueLocality: one(r.venues)?.locality ?? null,
      title: r.product_title,
      kind: r.product_kind,
      quantity: r.quantity,
      amountPence: r.amount_pence,
      currency: r.currency,
      status: r.status,
      redeemCode: r.status === "pending" || r.status === "canceled" ? null : r.redeem_code,
      createdAt: r.created_at,
    }));
  }),

  /** Owner: a venue's orders (RLS scopes to owned venues). Buyer identity stays out of it —
   *  the venue sees the redeem code and state, not who. */
  venueOrders: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("orders")
        .select("id, product_title, product_kind, quantity, amount_pence, application_fee_pence, currency, status, redeem_code, created_at")
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(200)) as {
        data:
          | { id: string; product_title: string; product_kind: string; quantity: number; amount_pence: number; application_fee_pence: number; currency: string; status: string; redeem_code: string | null; created_at: string }[]
          | null;
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load orders: ${error.message}` });
      return (data ?? []).map((r) => ({
        id: r.id,
        title: r.product_title,
        kind: r.product_kind,
        quantity: r.quantity,
        amountPence: r.amount_pence,
        feePence: r.application_fee_pence,
        currency: r.currency,
        status: r.status,
        redeemCode: r.redeem_code,
        createdAt: r.created_at,
      }));
    }),

  /** Owner: mark a PAID order fulfilled — collected (product) or redeemed (voucher). The
   *  ownership check is explicit (orders writes are service-only), and the eq(status,'paid')
   *  guard means a stale button press can't overwrite a refund. */
  fulfilOrder: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const { order, service } = await ownedOrder(ctx, input.orderId);
      const next = order.product_kind === "service" ? "redeemed" : "collected";
      const { data } = (await service
        .from("orders")
        .update({ status: next })
        .eq("id", input.orderId)
        .eq("status", "paid")
        .select("id")) as { data: { id: string }[] | null };
      return { ok: !!data && data.length > 0 };
    }),

  /** Owner: fully refund a paid/fulfilled order — Stripe pulls the funds back from the venue
   *  and returns Roam's fee; the buyer is made whole. */
  refundOrder: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      if (!ctx.env.stripe.secretKey) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Payments aren't configured on this environment yet." });
      }
      const { order, service } = await ownedOrder(ctx, input.orderId);
      if (!["paid", "collected", "redeemed"].includes(order.status) || !order.stripe_payment_intent_id) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only a paid order can be refunded." });
      }
      await refundPayment({ secretKey: ctx.env.stripe.secretKey }, { paymentIntent: order.stripe_payment_intent_id });
      const { data } = (await service
        .from("orders")
        .update({ status: "refunded" })
        .eq("id", input.orderId)
        .select("id")) as { data: { id: string }[] | null };
      // Tell the buyer (best-effort — the refund itself has already succeeded).
      if (order.buyer_id) {
        const pounds = `£${(order.amount_pence / 100).toFixed(order.amount_pence % 100 === 0 ? 0 : 2)}`;
        await service.from("notifications").insert({
          recipient_id: order.buyer_id,
          type: "order_refunded",
          payload: { text: `Refunded — “${order.product_title}” (${pounds}) is on its way back to your card.`, href: "/orders" },
        });
      }
      return { ok: !!data && data.length > 0 };
    }),

  /** Owner: remove an entry outright. (Orders, once they exist, will reference a snapshot —
   *  deleting a product never rewrites history.) */
  remove: protectedProcedure
    .input(z.object({ productId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .delete()
        .eq("id", input.productId)
        .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't remove that: ${error.message}` });
      return { ok: !!data && data.length > 0 };
    }),
});
