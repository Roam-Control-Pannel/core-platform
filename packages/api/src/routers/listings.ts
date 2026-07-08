/**
 * Listings router — the C2C buy/sell/swap marketplace (marketplace PR 4). Plain caller-RLS
 * CRUD (0072 policies are the boundary; no service escalation): everyone browses live
 * listings town-scoped; owners manage their own. No payments — the hand-off is chat.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

export const LISTING_CATEGORIES = [
  "furniture", "electronics", "clothing", "kids", "home", "garden", "sports", "books", "vehicles", "other",
] as const;

/** Shape both surfaces render. Seller is the public profile card fields only. */
export interface MarketListing {
  id: string;
  title: string;
  description: string | null;
  pricePence: number | null;
  mode: "sell" | "swap" | "free";
  category: string;
  locality: string | null;
  lat: number | null;
  lng: number | null;
  photoUrls: string[];
  status: "live" | "sold" | "removed";
  views: number;
  createdAt: string;
  seller: { id: string; displayName: string | null; handle: string | null; avatarUrl: string | null };
}

interface Row {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  price_pence: number | null;
  mode: "sell" | "swap" | "free";
  category: string;
  locality: string | null;
  lat: number | null;
  lng: number | null;
  photo_urls: unknown;
  status: "live" | "sold" | "removed";
  views: number | null;
  created_at: string;
  profiles: { id: string; display_name: string | null; handle: string | null; avatar_url: string | null } | { id: string; display_name: string | null; handle: string | null; avatar_url: string | null }[] | null;
}

const COLS = "id, owner_id, title, description, price_pence, mode, category, locality, lat, lng, photo_urls, status, views, created_at, profiles!market_listings_owner_id_fkey(id, display_name, handle, avatar_url)";

function shape(r: Row): MarketListing {
  const p = Array.isArray(r.profiles) ? (r.profiles[0] ?? null) : r.profiles;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    pricePence: r.price_pence,
    mode: r.mode,
    category: r.category,
    locality: r.locality,
    lat: r.lat,
    lng: r.lng,
    photoUrls: Array.isArray(r.photo_urls) ? (r.photo_urls as string[]).filter((u) => typeof u === "string").slice(0, 6) : [],
    status: r.status,
    views: r.views ?? 0,
    createdAt: r.created_at,
    seller: { id: p?.id ?? r.owner_id, displayName: p?.display_name ?? null, handle: p?.handle ?? null, avatarUrl: p?.avatar_url ?? null },
  };
}

type LooseDb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const listingFields = {
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).nullish(),
  pricePence: z.number().int().min(0).max(100_000_000).nullish(),
  mode: z.enum(["sell", "swap", "free"]),
  category: z.enum(LISTING_CATEGORIES),
  locality: z.string().trim().max(120).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  photoUrls: z.array(z.string().url().max(600)).max(6).default([]),
};

export const listingsRouter = router({
  /** Public: browse live listings, town-scoped (locality display-name match, Town Hall style). */
  browse: publicProcedure
    .input(z.object({
      localityName: z.string().trim().max(120).optional(),
      category: z.enum(LISTING_CATEGORIES).optional(),
      mode: z.enum(["sell", "swap", "free"]).optional(),
    }))
    .query(async ({ ctx, input }): Promise<MarketListing[]> => {
      const db = ctx.db as unknown as LooseDb;
      let q = db.from("market_listings").select(COLS).eq("status", "live");
      if (input.localityName) q = q.ilike("locality", input.localityName);
      if (input.category) q = q.eq("category", input.category);
      if (input.mode) q = q.eq("mode", input.mode);
      const { data, error } = (await q.order("created_at", { ascending: false }).limit(60)) as { data: Row[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load listings: ${error.message}` });
      return (data ?? []).map(shape);
    }),

  /** Public: one listing (live for everyone; owners can open their own sold/removed). */
  byId: publicProcedure
    .input(z.object({ listingId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<MarketListing | null> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db.from("market_listings").select(COLS).eq("id", input.listingId).maybeSingle()) as { data: Row | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load the listing: ${error.message}` });
      return data ? shape(data) : null;
    }),

  /** Owner: my listings, all statuses. */
  mine: protectedProcedure.query(async ({ ctx }): Promise<MarketListing[]> => {
    const { data: auth } = await (ctx.db as { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } }).auth.getUser();
    const uid = auth.user?.id;
    if (!uid) throw new TRPCError({ code: "UNAUTHORIZED" });
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db.from("market_listings").select(COLS).eq("owner_id", uid).order("created_at", { ascending: false }).limit(100)) as { data: Row[] | null; error: { message: string } | null };
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your listings: ${error.message}` });
    return (data ?? []).map(shape);
  }),

  /** Signed-in: post a listing. Selling needs a price; swap/free stores none. */
  create: protectedProcedure
    .input(z.object(listingFields))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean; id?: string }> => {
      if (input.mode === "sell" && (input.pricePence == null || input.pricePence <= 0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A for-sale listing needs a price." });
      }
      const { data: auth } = await (ctx.db as { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } }).auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED" });
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("market_listings")
        .insert({
          owner_id: uid,
          title: input.title,
          description: input.description ?? null,
          price_pence: input.mode === "sell" ? input.pricePence : null,
          mode: input.mode,
          category: input.category,
          locality: input.locality ?? null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          photo_urls: input.photoUrls,
        })
        .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't post that: ${error.message}` });
      const row = data?.[0];
      return row ? { ok: true, id: row.id } : { ok: false };
    }),

  /** Public: count a listing view (fire-and-forget from the detail page; identity-free). */
  recordView: publicProcedure
    .input(z.object({ listingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      type LooseRpc = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
      const { error } = await (ctx.db as unknown as LooseRpc).rpc("record_listing_view", { p_listing: input.listingId });
      return { ok: !error };
    }),

  /** Owner: mark sold / remove / relist (RLS scopes the write to own rows). */
  setStatus: protectedProcedure
    .input(z.object({ listingId: z.string().uuid(), status: z.enum(["live", "sold", "removed"]) }))
    .mutation(async ({ ctx, input }): Promise<{ ok: boolean }> => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("market_listings")
        .update({ status: input.status })
        .eq("id", input.listingId)
        .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't update that: ${error.message}` });
      return { ok: !!data && data.length > 0 };
    }),
});
