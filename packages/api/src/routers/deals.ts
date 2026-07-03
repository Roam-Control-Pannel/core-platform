/**
 * Deals router — the public read surface for Awin affiliate deals.
 *
 * `list` returns LIVE deals (RLS awin_deals_public_read already scopes to active + in-window rows;
 * we just order + limit). World-readable: signed-out browsing sees deals (browse-freely contract).
 * The affiliate tracking link is NOT built here — the web surface wraps `destinationUrl` with the
 * public publisher id at render time (see apps/web/src/lib/awin.ts), so the id lives in one place.
 *
 * Rows are populated by the Awin Offers ingestion (a later PR) using the service role; this router
 * only reads. Every resolver returns inline structural types (no AppRouter leak).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";

// Loose db: awin_deals isn't in the generated types until they're regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any };

export const dealsRouter = router({
  /** Public: live affiliate deals, newest first. Optional category filter + limit. */
  list: publicProcedure
    .input(
      z
        .object({
          category: z.string().trim().min(1).max(60).optional(),
          limit: z.number().int().min(1).max(50).default(24),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      let q = db
        .from("awin_deals")
        .select(
          "id, advertiser_id, advertiser_name, title, description, kind, voucher_code, terms, destination_url, image_url, category, ends_at",
        )
        .order("created_at", { ascending: false })
        .limit(input?.limit ?? 24);
      if (input?.category) q = q.eq("category", input.category);
      const { data, error } = (await q) as {
        data:
          | {
              id: string;
              advertiser_id: string;
              advertiser_name: string | null;
              title: string;
              description: string | null;
              kind: string;
              voucher_code: string | null;
              terms: string | null;
              destination_url: string;
              image_url: string | null;
              category: string | null;
              ends_at: string | null;
            }[]
          | null;
        error: { message: string } | null;
      };
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load deals: ${error.message}` });
      }
      return (data ?? []).map((d) => ({
        id: d.id,
        advertiserId: d.advertiser_id,
        advertiserName: d.advertiser_name,
        title: d.title,
        description: d.description,
        kind: (d.kind === "voucher" ? "voucher" : "offer") as "voucher" | "offer",
        voucherCode: d.voucher_code,
        terms: d.terms,
        destinationUrl: d.destination_url,
        imageUrl: d.image_url,
        category: d.category,
        endsAt: d.ends_at,
      }));
    }),
});
