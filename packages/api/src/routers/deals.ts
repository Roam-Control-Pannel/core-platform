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

/** Strip ILIKE / PostgREST-.or() control chars so a user's search term is matched literally. */
function sanitizeTerm(q: string): string {
  return q.replace(/[%,()\\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Read one network's live deals. `required` throws on error (Awin, the established table); the
 *  optional network (CJ) swallows errors so a missing table pre-migration degrades to Awin-only. */
async function readDeals(
  db: LooseDb,
  table: string,
  network: Network,
  opts: { category?: string | undefined; q?: string | undefined; limit: number; required: boolean },
): Promise<ReturnType<typeof shapeDeal>[]> {
  let q = db.from(table).select(DEAL_COLS).order("created_at", { ascending: false }).limit(opts.limit);
  if (opts.category) q = q.eq("category", opts.category);
  if (opts.q) {
    const term = sanitizeTerm(opts.q);
    if (term) q = q.or(`title.ilike.%${term}%,advertiser_name.ilike.%${term}%`);
  }
  const { data, error } = (await q) as { data: RawDeal[] | null; error: { message: string } | null };
  if (error) {
    if (opts.required) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load deals: ${error.message}` });
    }
    return [];
  }
  return (data ?? []).map((d) => shapeDeal(d, network));
}

/**
 * Fill in advertiser logos for CJ deals that have no image of their own: look up each deal's
 * advertiser in cj_advertisers (0111, populated by the syncCjLogos job) and use its logo as the
 * deal's imageUrl, so the card shows the real brand logo instead of the generic category icon.
 * Best-effort — mutates the passed deals in place, and degrades silently (deals keep their icon
 * fallback) if the table doesn't exist yet or the lookup errors. No-op when every CJ deal already
 * has an image, or none carries an advertiser id.
 */
async function attachCjLogos(db: LooseDb, deals: ReturnType<typeof shapeDeal>[]): Promise<void> {
  const need = deals.filter((d) => !d.imageUrl && d.advertiserId);
  if (need.length === 0) return;
  const ids = [...new Set(need.map((d) => d.advertiserId))];
  try {
    const { data, error } = (await db
      .from("cj_advertisers")
      .select("advertiser_id, logo_url")
      .in("advertiser_id", ids)) as { data: { advertiser_id: string; logo_url: string | null }[] | null; error: unknown };
    if (error || !Array.isArray(data)) return;
    const logoById = new Map(data.filter((r) => r.logo_url).map((r) => [r.advertiser_id, r.logo_url as string]));
    for (const d of need) {
      const logo = logoById.get(d.advertiserId);
      if (logo) d.imageUrl = logo;
    }
  } catch {
    // Pre-migration / transient: leave deals as-is (icon fallback).
  }
}

/** Round-robin two recency-sorted lists (a0, c0, a1, c1, …) so neither network buries the other —
 *  even when one has 900 fresh rows and the other 20. Deterministic given the inputs, so paginating
 *  by offset over the interleaved sequence yields contiguous, non-overlapping pages. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}

export const dealsRouter = router({
  /**
   * Public: a page of live affiliate deals, INTERLEAVED across both networks (Awin + CJ) so neither
   * dominates, newest-first within each. Offset-paginated: each call fetches enough of each network
   * to reconstruct the interleaved window [offset, offset+limit) exactly, then returns that slice +
   * whether more remain. Optional category filter.
   */
  list: publicProcedure
    .input(
      z
        .object({
          category: z.string().trim().min(1).max(80).optional(),
          q: z.string().trim().min(1).max(80).optional(),
          limit: z.number().int().min(1).max(48).default(24),
          offset: z.number().int().min(0).max(2000).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const limit = input?.limit ?? 24;
      const offset = input?.offset ?? 0;
      const category = input?.category;
      const q = input?.q;
      const end = offset + limit;
      // Fetch end+1 newest from each network (CJ best-effort) — enough to compute the interleaved
      // sequence up to `end` and to tell whether anything remains beyond this page.
      const [awin, cj] = await Promise.all([
        readDeals(db, "awin_deals", "awin", { category, q, limit: end + 1, required: true }),
        readDeals(db, "cj_deals", "cj", { category, q, limit: end + 1, required: false }),
      ]);
      await attachCjLogos(db, cj); // brand logos for CJ cards without an image (best-effort)
      const merged = interleave(awin, cj);
      return { deals: merged.slice(offset, end), hasMore: merged.length > end };
    }),

  /** Public: the distinct live-deal categories across both networks (deal_categories, 0110), most-
   *  populated first — the filter chips on /deals. Fault-tolerant: no chips pre-migration. */
  categories: publicProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    const { data, error } = await db.rpc("deal_categories", { p_limit: 14 });
    if (error) return { categories: [] as { category: string; count: number }[] };
    const rows = Array.isArray(data) ? (data as { category?: string; deal_count?: number | string }[]) : [];
    const categories = rows
      .map((r) => ({ category: String(r.category ?? ""), count: Number(r.deal_count ?? 0) || 0 }))
      .filter((c) => c.category !== "");
    return { categories };
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
      const awinDeal = await readOne("awin_deals", "awin", true);
      if (awinDeal) return awinDeal;
      const cjDeal = await readOne("cj_deals", "cj", false);
      if (cjDeal) await attachCjLogos(db, [cjDeal]); // brand logo for a CJ permalink (best-effort)
      return cjDeal;
    }),
});
