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
import type { RoamClient } from "@roam/db";
import { f2g } from "@roam/core";
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import { createCheckoutSession, createCartCheckoutSession, refundPayment } from "../stripe/client.js";
import { geocodeSearch } from "../geocode/client.js";
import { pushToProfileIds } from "../push/dispatch.js";

/** Map a checkDeliverable reason to a buyer-facing checkout error message. */
function deliverabilityMessage(reason: f2g.DeliverabilityReason): string {
  switch (reason) {
    case "delivery_unavailable":
      return "This venue isn't delivering right now.";
    case "outside_ni":
      return "Delivery is only available within Northern Ireland.";
    case "no_destination":
      return "We couldn't locate that address — please check the postcode.";
    case "postcode_blocked":
    case "outside_area":
      return "Sorry, this venue doesn't deliver to that address.";
    default:
      return "Sorry, this venue can't deliver to that address.";
  }
}

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

/** The DB row shape read by myOrders / venueOrders (delivery fields + joined basket items). */
interface OrderReadRow {
  id: string;
  venue_id: string;
  product_title: string;
  product_kind: string;
  quantity: number;
  amount_pence: number;
  application_fee_pence?: number;
  delivery_fee_pence: number | null;
  currency: string;
  status: string;
  fulfilment_type: string | null;
  redeem_code: string | null;
  ready_at: string | null;
  delivery_eta_at: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  delivery_address: unknown;
  created_at: string;
  venues?: { name: string; locality: string | null } | { name: string; locality: string | null }[] | null;
  order_items?: { product_title: string; unit_price_pence: number; quantity: number }[] | null;
}

/** Normalise a stored delivery_address jsonb into a safe display shape (structural inference). */
function shapeAddress(a: unknown) {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const line1 = str(o.line1);
  const postcode = str(o.postcode);
  if (!line1 && !postcode) return null;
  return {
    line1: line1 ?? "",
    line2: str(o.line2),
    locality: str(o.locality),
    postcode: postcode ?? "",
    notes: str(o.notes),
  };
}

/** Map joined order_items rows into the basket line shape the order surfaces render. */
function shapeItems(items: { product_title: string; unit_price_pence: number; quantity: number }[] | null | undefined) {
  return (items ?? []).map((i) => ({ title: i.product_title, unitPricePence: i.unit_price_pence, quantity: i.quantity }));
}

const productFields = {
  kind: z.enum(["product", "service"]),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).nullish(),
  pricePence: z.number().int().min(50).max(999_900),
  stock: z.number().int().min(0).max(100_000).nullish(),
  photoUrl: z.string().trim().url().max(600).nullish(),
};

/** Load an order and verify the CALLER owns its venue (buyer readability isn't enough for
 *  owner actions). Returns the row + a service client for the state write. */
async function ownedOrder(
  ctx: { db: unknown; env: Parameters<typeof escalateToService>[0] },
  orderId: string,
): Promise<{
  order: { id: string; venue_id: string; product_kind: string; fulfilment_type: string; status: string; stripe_payment_intent_id: string | null; buyer_id: string | null; product_title: string; amount_pence: number };
  service: LooseDb;
}> {
  const { data: auth } = await (ctx.db as { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } }).auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new TRPCError({ code: "UNAUTHORIZED" });
  const service = escalateToService(ctx.env) as unknown as LooseDb;
  const { data: order } = (await service
    .from("orders")
    .select("id, venue_id, product_kind, fulfilment_type, status, stripe_payment_intent_id, buyer_id, product_title, amount_pence")
    .eq("id", orderId)
    .maybeSingle()) as { data: { id: string; venue_id: string; product_kind: string; fulfilment_type: string; status: string; stripe_payment_intent_id: string | null; buyer_id: string | null; product_title: string; amount_pence: number } | null };
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
  /**
   * Public: the TOWN-WIDE shop feed — every live product across the locality's claimed
   * venues, newest first, each carrying its venue's public card fields (name, category,
   * rating) so the Market page renders "product by venue" cards without N venue lookups.
   * Locality matches on the display name, Town Hall style.
   */
  browseProducts: publicProcedure
    .input(z.object({ localityName: z.string().trim().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      type VenueEmbed = { id: string; name: string; locality: string | null; category: string | null; rating: number | null; status: string };
      type FeedRow = Row & { venues: VenueEmbed | VenueEmbed[] | null };
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .select(`${COLS}, venues!inner(id, name, locality, category, rating, status)`)
        .eq("active", true)
        .eq("venues.status", "claimed")
        .ilike("venues.locality", input.localityName)
        .order("created_at", { ascending: false })
        .limit(80)) as { data: FeedRow[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load the market: ${error.message}` });
      const one = (v: VenueEmbed | VenueEmbed[] | null): VenueEmbed | null => (Array.isArray(v) ? (v[0] ?? null) : v);
      return (data ?? []).map((r) => {
        const v = one(r.venues);
        return {
          ...shape(r),
          venue: {
            id: v?.id ?? r.venue_id,
            name: v?.name ?? "A venue",
            category: v?.category ?? null,
            rating: v?.rating ?? null,
          },
        };
      });
    }),

  /** Public: a venue's live catalogue (active products, newest first) + whether the venue
   *  can take online payments right now ("is there a Buy button" is public information). */
  listByVenue: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<{ sellable: boolean; paused: boolean; products: MarketProduct[] }> => {
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
      // Paused is a venue-wide collection setting: checkout blocks a paused venue on EVERY channel
      // (the unified collect model), so surface it here — publicly readable — to keep the Buy button
      // honest on Roam too, not only inside the f2g storefront chrome.
      const { data: collection } = (await db
        .from("venue_collection_settings")
        .select("paused")
        .eq("venue_id", input.venueId)
        .maybeSingle()) as { data: { paused: boolean } | null };
      return { sellable, paused: !!collection?.paused, products: (data ?? []).map(shape) };
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

      // Order-ahead & collect (Phase 3): a paused venue can't take new orders, and every order
      // gets an estimated ready-at (now + the venue's prep time) shown to the buyer as a collection
      // ticket. Absent settings = the app-layer defaults (not paused, 15 min).
      const { data: collection } = (await service
        .from("venue_collection_settings")
        .select("paused, prep_time_mins")
        .eq("venue_id", prod.venue_id)
        .maybeSingle()) as { data: { paused: boolean; prep_time_mins: number } | null };
      if (collection?.paused) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This venue has paused new orders — please try again shortly." });
      }
      const prepMins = collection?.prep_time_mins ?? 15;
      const readyAt = new Date(Date.now() + prepMins * 60_000).toISOString();

      const amount = prod.price_pence * input.quantity;
      const fee = Math.round((amount * ctx.env.stripe.applicationFeeBps) / 10_000);
      // Every order carries a collection code now (not just vouchers): it's the buyer's ticket to
      // collect and the code the vendor verifies at the counter.
      const redeemCode = randomBytes(5).toString("hex").toUpperCase();

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
          ready_at: readyAt,
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

  /**
   * Buyer: check out a CART (Food to Go) — one or more product lines, collected or delivered, in a
   * single order + Stripe session. For delivery: the address is geocoded server-side (NI-fenced,
   * authoritative — client coordinates are never trusted), checked against the venue's delivery
   * settings (deliverable area + minimum order), and a flat delivery fee is added as its own Stripe
   * line. Platform commission is on the GOODS subtotal only, so the vendor keeps the delivery fee.
   * Services/vouchers stay on the single-item `checkout` above; this cart is food products only.
   */
  checkoutCart: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        items: z
          .array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(20) }))
          .min(1)
          .max(50),
        fulfilment: z.enum(["collection", "delivery"]).default("collection"),
        address: z
          .object({
            line1: z.string().trim().min(1).max(120),
            line2: z.string().trim().max(120).nullish(),
            locality: z.string().trim().max(120).nullish(),
            postcode: z.string().trim().min(2).max(12),
            notes: z.string().trim().max(300).nullish(),
          })
          .nullish(),
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

      // Load every requested product for this venue, active-only, and merge duplicate lines.
      const ids = [...new Set(input.items.map((i) => i.productId))];
      const { data: prods } = (await service
        .from("venue_products")
        .select(COLS)
        .in("id", ids)
        .eq("venue_id", input.venueId)
        .eq("active", true)) as { data: Row[] | null };
      const byId = new Map((prods ?? []).map((p) => [p.id, p]));
      const qtyById = new Map<string, number>();
      for (const it of input.items) qtyById.set(it.productId, (qtyById.get(it.productId) ?? 0) + it.quantity);

      const lines: { productId: string; title: string; unitPricePence: number; quantity: number }[] = [];
      let currency = "gbp";
      for (const [pid, qty] of qtyById) {
        const p = byId.get(pid);
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "An item in your basket is no longer available." });
        if (p.kind !== "product") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Vouchers can only be bought one at a time, not in a basket." });
        }
        if (p.stock != null && p.stock < qty) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: p.stock === 0 ? `Sold out — ${p.title}.` : `Only ${p.stock} of ${p.title} left.` });
        }
        currency = p.currency;
        lines.push({ productId: pid, title: p.title, unitPricePence: p.price_pence, quantity: qty });
      }
      if (lines.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Your basket is empty." });

      const { data: acct } = (await service
        .from("venue_payment_accounts")
        .select("stripe_account_id, charges_enabled")
        .eq("venue_id", input.venueId)
        .maybeSingle()) as { data: { stripe_account_id: string; charges_enabled: boolean } | null };
      if (!acct?.charges_enabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This venue isn't taking online payments yet." });
      }

      const goodsSubtotal = lines.reduce((s, l) => s + l.unitPricePence * l.quantity, 0);
      let deliveryFeePence = 0;
      let deliveryAddressJson: Record<string, unknown> | null = null;
      let readyAt: string | null = null;
      let deliveryEtaAt: string | null = null;

      if (input.fulfilment === "delivery") {
        if (!input.address) throw new TRPCError({ code: "BAD_REQUEST", message: "A delivery address is required." });
        const settings = await f2g.getDeliverySettings(service as unknown as RoamClient, input.venueId);
        if (!settings.deliveryEnabled || settings.paused) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This venue isn't delivering right now." });
        }
        if (goodsSubtotal < settings.minOrderPence) {
          const min = `£${(settings.minOrderPence / 100).toFixed(2)}`;
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The minimum order for delivery is ${min}.` });
        }
        const { data: venue } = (await service
          .from("venues")
          .select("lat, lng")
          .eq("id", input.venueId)
          .maybeSingle()) as { data: { lat: number | null; lng: number | null } | null };
        if (typeof venue?.lat !== "number" || typeof venue?.lng !== "number") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This venue's location isn't set, so we can't check delivery." });
        }
        // Geocode the address server-side, NI-fenced — the authoritative coordinate for the fence.
        const query = [input.address.line1, input.address.postcode].filter(Boolean).join(", ");
        let hit: { lat: number; lng: number } | undefined;
        try {
          const geo = await geocodeSearch(query, undefined, { region: "ni" });
          hit = geo[0];
        } catch {
          /* geocode failure → treated as no destination below */
        }
        const check = f2g.checkDeliverable({
          settings,
          venue: { lat: venue.lat, lng: venue.lng },
          destLat: hit?.lat ?? null,
          destLng: hit?.lng ?? null,
          destPostcode: input.address.postcode,
        });
        if (!check.deliverable) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: deliverabilityMessage(check.reason) });
        }
        deliveryFeePence = settings.deliveryFeePence;
        deliveryEtaAt = new Date(Date.now() + settings.etaMins * 60_000).toISOString();
        deliveryAddressJson = {
          line1: input.address.line1,
          line2: input.address.line2 ?? null,
          locality: input.address.locality ?? null,
          postcode: input.address.postcode.toUpperCase(),
          notes: input.address.notes ?? null,
          lat: hit?.lat ?? null,
          lng: hit?.lng ?? null,
        };
      } else {
        const collection = await f2g.getCollectionSettings(service as unknown as RoamClient, input.venueId);
        if (collection.paused) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This venue has paused new orders — please try again shortly." });
        }
        readyAt = new Date(Date.now() + collection.prepTimeMins * 60_000).toISOString();
      }

      const totals = f2g.computeOrderTotals(
        lines.map((l) => ({ unitPricePence: l.unitPricePence, quantity: l.quantity })),
        deliveryFeePence,
        ctx.env.stripe.applicationFeeBps,
      );
      const redeemCode = randomBytes(5).toString("hex").toUpperCase();
      const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
      const summaryTitle = lines.length === 1 ? lines[0]!.title : `${lines[0]!.title} +${lines.length - 1} more`;

      const { data: created, error: orderErr } = (await service
        .from("orders")
        .insert({
          venue_id: input.venueId,
          buyer_id: buyerId,
          product_id: lines.length === 1 ? lines[0]!.productId : null,
          product_title: summaryTitle,
          product_kind: "product",
          quantity: itemCount,
          amount_pence: totals.goodsSubtotalPence,
          application_fee_pence: totals.applicationFeePence,
          delivery_fee_pence: totals.deliveryFeePence,
          fulfilment_type: input.fulfilment,
          delivery_address: deliveryAddressJson,
          currency,
          redeem_code: redeemCode,
          ready_at: readyAt,
          delivery_eta_at: deliveryEtaAt,
          referrer_profile_id: input.referrerId ?? null,
        })
        .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };
      const order = created?.[0];
      if (orderErr || !order) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't start checkout: ${orderErr?.message ?? "order not created"}` });
      }

      const { error: itemsErr } = (await service.from("order_items").insert(
        lines.map((l) => ({
          order_id: order.id,
          product_id: l.productId,
          product_title: l.title,
          unit_price_pence: l.unitPricePence,
          quantity: l.quantity,
        })),
      )) as { error: { message: string } | null };
      if (itemsErr) {
        // The basket lines are essential — roll the header back rather than leave a lineless order.
        await service.from("orders").delete().eq("id", order.id);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't start checkout: ${itemsErr.message}` });
      }

      const base = ctx.env.stripe.webOrigin.replace(/\/$/, "");
      const session = await createCartCheckoutSession({ secretKey: ctx.env.stripe.secretKey }, {
        destinationAccount: acct.stripe_account_id,
        applicationFeePence: totals.applicationFeePence,
        currency,
        lines: lines.map((l) => ({ title: l.title, unitAmountPence: l.unitPricePence, quantity: l.quantity })),
        deliveryFeePence: totals.deliveryFeePence,
        deliveryLabel: "Delivery",
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
      .select(
        "id, venue_id, product_title, product_kind, quantity, amount_pence, delivery_fee_pence, currency, status, fulfilment_type, redeem_code, ready_at, delivery_eta_at, out_for_delivery_at, delivered_at, delivery_address, created_at, venues(name, locality), order_items(product_title, unit_price_pence, quantity)",
      )
      .order("created_at", { ascending: false })
      .limit(100)) as {
      data: OrderReadRow[] | null;
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
      deliveryFeePence: r.delivery_fee_pence ?? 0,
      currency: r.currency,
      status: r.status,
      fulfilment: r.fulfilment_type === "delivery" ? ("delivery" as const) : ("collection" as const),
      redeemCode: r.status === "pending" || r.status === "canceled" ? null : r.redeem_code,
      readyAt: r.ready_at,
      deliveryEtaAt: r.delivery_eta_at,
      outForDeliveryAt: r.out_for_delivery_at,
      deliveredAt: r.delivered_at,
      deliveryAddress: shapeAddress(r.delivery_address),
      items: shapeItems(r.order_items),
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
        .select(
          "id, venue_id, product_title, product_kind, quantity, amount_pence, application_fee_pence, delivery_fee_pence, currency, status, fulfilment_type, redeem_code, ready_at, delivery_eta_at, out_for_delivery_at, delivered_at, delivery_address, created_at, order_items(product_title, unit_price_pence, quantity)",
        )
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(200)) as {
        data: OrderReadRow[] | null;
        error: { message: string } | null;
      };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load orders: ${error.message}` });
      return (data ?? []).map((r) => ({
        id: r.id,
        title: r.product_title,
        kind: r.product_kind,
        quantity: r.quantity,
        amountPence: r.amount_pence,
        feePence: r.application_fee_pence ?? 0,
        deliveryFeePence: r.delivery_fee_pence ?? 0,
        currency: r.currency,
        status: r.status,
        fulfilment: r.fulfilment_type === "delivery" ? ("delivery" as const) : ("collection" as const),
        redeemCode: r.redeem_code,
        readyAt: r.ready_at,
        deliveryEtaAt: r.delivery_eta_at,
        outForDeliveryAt: r.out_for_delivery_at,
        deliveredAt: r.delivered_at,
        deliveryAddress: shapeAddress(r.delivery_address),
        items: shapeItems(r.order_items),
        createdAt: r.created_at,
      }));
    }),

  /**
   * Owner: mark a PAID order READY for collection (Food to Go). paid → ready, guarded so a stale
   * click can't move an already-collected/refunded order. The "your order is ready" notification +
   * push are wired in Phase 3D. Optional in the flow: a vendor may also go straight paid → collected.
   */
  markReady: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const { order, service } = await ownedOrder(ctx, input.orderId);
      const { data } = (await service
        .from("orders")
        .update({ status: "ready" })
        .eq("id", input.orderId)
        .eq("status", "paid")
        .select("id")) as { data: { id: string }[] | null };
      const moved = !!data && data.length > 0;

      // Tell the buyer their order is ready — a bell row + a web push (both best-effort; a failure
      // here never fails the vendor's action). Only when we actually moved paid → ready.
      if (moved && order.buyer_id) {
        await service.from("notifications").insert({
          recipient_id: order.buyer_id,
          type: "order_ready",
          payload: { text: `Ready to collect — ${order.product_title}`, href: "/orders" },
        });
        try {
          await pushToProfileIds(escalateToService(ctx.env) as RoamClient, ctx.env.vapid, [order.buyer_id], {
            url: "/orders",
            title: "Ready to collect",
            body: `${order.product_title} is ready — head over when you can.`,
          });
        } catch {
          /* push is best-effort */
        }
      }
      return { ok: moved };
    }),

  /** Owner: mark an order fulfilled — collected (product) or redeemed (voucher). Accepts a PAID
   *  order (direct) or a READY one (order-ahead flow: paid → ready → collected). The ownership
   *  check is explicit (orders writes are service-only), and the status guard means a stale button
   *  press can't overwrite a refund. */
  fulfilOrder: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const { order, service } = await ownedOrder(ctx, input.orderId);
      const next = order.product_kind === "service" ? "redeemed" : "collected";
      const { data } = (await service
        .from("orders")
        .update({ status: next })
        .eq("id", input.orderId)
        .in("status", ["paid", "ready"])
        .select("id")) as { data: { id: string }[] | null };
      return { ok: !!data && data.length > 0 };
    }),

  /**
   * Owner: mark a DELIVERY order out for delivery. paid|ready → out_for_delivery, guarded so a
   * stale click can't move a delivered/refunded order. Notifies the buyer (bell + push, best-effort).
   */
  markOutForDelivery: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const { order, service } = await ownedOrder(ctx, input.orderId);
      if (order.fulfilment_type !== "delivery") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This isn't a delivery order." });
      }
      const { data } = (await service
        .from("orders")
        .update({ status: "out_for_delivery", out_for_delivery_at: new Date().toISOString() })
        .eq("id", input.orderId)
        .in("status", ["paid", "ready"])
        .select("id")) as { data: { id: string }[] | null };
      const moved = !!data && data.length > 0;
      if (moved && order.buyer_id) {
        await service.from("notifications").insert({
          recipient_id: order.buyer_id,
          type: "order_out_for_delivery",
          payload: { text: `Out for delivery — ${order.product_title}`, href: "/orders" },
        });
        try {
          await pushToProfileIds(escalateToService(ctx.env) as RoamClient, ctx.env.vapid, [order.buyer_id], {
            url: "/orders",
            title: "Out for delivery",
            body: `${order.product_title} is on its way.`,
          });
        } catch {
          /* push is best-effort */
        }
      }
      return { ok: moved };
    }),

  /** Owner: mark a DELIVERY order delivered. out_for_delivery → delivered, guarded. Notifies the buyer. */
  markDelivered: protectedProcedure
    .input(z.object({ orderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const { order, service } = await ownedOrder(ctx, input.orderId);
      if (order.fulfilment_type !== "delivery") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This isn't a delivery order." });
      }
      const { data } = (await service
        .from("orders")
        .update({ status: "delivered", delivered_at: new Date().toISOString() })
        .eq("id", input.orderId)
        .eq("status", "out_for_delivery")
        .select("id")) as { data: { id: string }[] | null };
      const moved = !!data && data.length > 0;
      if (moved && order.buyer_id) {
        await service.from("notifications").insert({
          recipient_id: order.buyer_id,
          type: "order_delivered",
          payload: { text: `Delivered — ${order.product_title}. Enjoy!`, href: "/orders" },
        });
        try {
          await pushToProfileIds(escalateToService(ctx.env) as RoamClient, ctx.env.vapid, [order.buyer_id], {
            url: "/orders",
            title: "Delivered",
            body: `${order.product_title} has been delivered. Enjoy!`,
          });
        } catch {
          /* push is best-effort */
        }
      }
      return { ok: moved };
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
      if (
        !["paid", "ready", "out_for_delivery", "delivered", "collected", "redeemed"].includes(order.status) ||
        !order.stripe_payment_intent_id
      ) {
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
