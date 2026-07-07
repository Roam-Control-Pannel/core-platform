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
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

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

export const marketRouter = router({
  /** Public: a venue's live catalogue (active products, newest first). */
  listByVenue: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<MarketProduct[]> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_products")
        .select(COLS)
        .eq("venue_id", input.venueId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(100)) as { data: Row[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load the shop: ${error.message}` });
      return (data ?? []).map(shape);
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
