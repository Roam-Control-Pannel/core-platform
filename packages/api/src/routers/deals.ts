/**
 * Deals router — the public read surface for affiliate deals, unioning TWO networks: Awin
 * (awin_deals, 0062) and CJ / Commission Junction (cj_deals, 0109). Both are world-readable LIVE
 * rows (each table's RLS scopes to active + in-window); we read both, merge, sort by recency, limit.
 *
 * Each returned deal carries its `network` so the web builds the right click-through: an Awin
 * destination is tracking-wrapped at render (the public publisher id lives in the web bundle, see
 * apps/web/src/lib/dealLink.ts), whereas a CJ `destinationUrl` is CJ's clickUrl — ALREADY tracked —
 * and is used verbatim.
 *
 * Rows are populated by the per-network ingestion jobs (service role); this router only reads. The
 * CJ read is best-effort: if cj_deals doesn't exist yet (pre-migration) it degrades to Awin-only,
 * never a thrown page. Every resolver returns inline structural types (no AppRouter leak).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";

// Loose db: the *_deals tables aren't in the generated types until regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any };

type Network = "awin" | "cj";

const DEAL_COLS =
  "id, advertiser_id, advertiser_name, title, description, kind, voucher_code, terms, destination_url, image_url, category, ends_at, created_at";

interface RawDeal {
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
  created_at: string;
}

function shapeDeal(d: RawDeal, network: Network) {
  return {
    id: d.id,
    network,
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
    createdAt: d.created_at,
  };
}

/** Read one network's live deals. `required` throws on error (Awin, the established table); the
 *  optional network (CJ) swallows errors so a missing table pre-migration degrades to Awin-only. */
async function readDeals(
  db: LooseDb,
  table: string,
  network: Network,
  opts: { category?: string | undefined; limit: number; required: boolean },
): Promise<ReturnType<typeof shapeDeal>[]> {
  let q = db.from(table).select(DEAL_COLS).order("created_at", { ascending: false }).limit(opts.limit);
  if (opts.category) q = q.eq("category", opts.category);
  const { data, error } = (await q) as { data: RawDeal[] | null; error: { message: string } | null };
  if (error) {
    if (opts.required) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load deals: ${error.message}` });
    }
    return [];
  }
  return (data ?? []).map((d) => shapeDeal(d, network));
}

export const dealsRouter = router({
  /** Public: live affiliate deals across both networks, newest first. Optional category + limit. */
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
      const limit = input?.limit ?? 24;
      const category = input?.category;
      // Fetch up to `limit` from each network (best-effort for CJ), then merge → recency → cap.
      const [awin, cj] = await Promise.all([
        readDeals(db, "awin_deals", "awin", { category, limit, required: true }),
        readDeals(db, "cj_deals", "cj", { category, limit, required: false }),
      ]);
      return [...awin, ...cj]
        .sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0))
        .slice(0, limit);
    }),

  /** Public: one deal by id — the /deals/[dealId] permalink read. Tries Awin, then CJ. RLS hides
   *  retired/expired rows. */
  byId: publicProcedure
    .input(z.object({ dealId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const readOne = async (table: string, network: Network, required: boolean) => {
        const { data, error } = (await db
          .from(table)
          .select(DEAL_COLS)
          .eq("id", input.dealId)
          .maybeSingle()) as { data: RawDeal | null; error: { message: string } | null };
        if (error) {
          if (required) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load this deal: ${error.message}` });
          return null;
        }
        return data ? shapeDeal(data, network) : null;
      };
      return (await readOne("awin_deals", "awin", true)) ?? (await readOne("cj_deals", "cj", false));
    }),
});
