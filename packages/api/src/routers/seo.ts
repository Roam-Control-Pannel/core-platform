/**
 * SEO router — public, read-only lists that feed the web app's sitemap.xml.
 *
 * Each procedure returns a capped set of a public content type's identifiers plus a
 * last-modified timestamp, so apps/web/src/app/sitemap.ts can render <url> entries with
 * <lastmod> for crawlers. Reads only; every table here is world-readable under RLS
 * (venues_select_public, profiles_read using(true), posts published+approved, the
 * town_hall_* public policies), so the anonymous ctx.db is sufficient.
 *
 * Lists are capped (a sitemap file should stay well under the 50k-URL / 50MB limit) and
 * ordered most-recent-first so the freshest, most index-worthy URLs always make the cut.
 * The town_hall_* and (loosely) other tables aren't all in the generated DB types, so we
 * use the loose-client idiom (same as townHall/profiles); every resolver returns an INLINE
 * structural object so no named type leaks into AppRouter (TS2883/4023).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { localitySlug } from "../town-hall.js";

type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** A single sitemap-eligible URL's identifier + freshness. */
const limitInput = z.object({ limit: z.number().int().min(1).max(20000).default(5000) });

function fail(what: string, message: string): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load ${what} for the sitemap: ${message}` });
}

export const seoRouter = router({
  /** Public: venue ids + slugs (+ last update) for /venue sitemap entries, freshest first. */
  venues: publicProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("venues")
      .select("id, slug, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(input.limit)) as {
      data: { id: string; slug: string | null; updated_at: string | null; created_at: string | null }[] | null;
      error: { message: string } | null;
    };
    if (error) fail("venues", error.message);
    return (data ?? []).map((v) => ({ id: v.id, slug: v.slug ?? null, lastmod: v.updated_at ?? v.created_at ?? null }));
  }),

  /** Public: profile ids (+ handle, for future slug URLs) for /u/[id] sitemap entries. */
  profiles: publicProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("profiles")
      .select("id, handle, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(input.limit)) as {
      data: { id: string; handle: string | null; updated_at: string | null; created_at: string | null }[] | null;
      error: { message: string } | null;
    };
    if (error) fail("profiles", error.message);
    return (data ?? []).map((p) => ({ id: p.id, handle: p.handle ?? null, lastmod: p.updated_at ?? p.created_at ?? null }));
  }),

  /** Public: published post ids (+ publish time) for /feed/[postId] sitemap entries. */
  posts: publicProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("posts")
      .select("id, published_at")
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(input.limit)) as {
      data: { id: string; published_at: string | null }[] | null;
      error: { message: string } | null;
    };
    if (error) fail("posts", error.message);
    return (data ?? []).map((p) => ({ id: p.id, lastmod: p.published_at ?? null }));
  }),

  /** Public: published event ids (+ last update) for /events/[id] sitemap entries, freshest first.
   *  Cancelled events are excluded — their pages noindex, so listing them would advertise URLs
   *  we tell crawlers to drop (same rule as sold listings). */
  events: publicProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("events")
      .select("id, updated_at, created_at")
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(input.limit)) as {
      data: { id: string; updated_at: string | null; created_at: string | null }[] | null;
      error: { message: string } | null;
    };
    if (error) fail("events", error.message);
    return (data ?? []).map((e) => ({ id: e.id, lastmod: e.updated_at ?? e.created_at ?? null }));
  }),

  /** Public: town-hall topic ids (+ locality, slug, last activity) for nested sitemap entries. */
  topics: publicProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("town_hall_topics")
      .select("id, locality, slug, last_activity_at, created_at")
      .order("last_activity_at", { ascending: false })
      .limit(input.limit)) as {
      data: { id: string; locality: string | null; slug: string | null; last_activity_at: string | null; created_at: string | null }[] | null;
      error: { message: string } | null;
    };
    if (error) fail("topics", error.message);
    return (data ?? []).map((t) => ({
      id: t.id,
      locality: t.locality ?? null,
      slug: t.slug ?? null,
      lastmod: t.last_activity_at ?? t.created_at ?? null,
    }));
  }),

  /** Public: LIVE marketplace listing ids (+ created time) for /market/[id] sitemap entries.
   *  Sold/removed listings are excluded — their pages flip to noindex, so listing them would
   *  advertise URLs we're telling crawlers to drop. */
  listings: publicProcedure.input(limitInput).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("market_listings")
      .select("id, created_at")
      .eq("status", "live")
      .order("created_at", { ascending: false })
      .limit(input.limit)) as {
      data: { id: string; created_at: string | null }[] | null;
      error: { message: string } | null;
    };
    if (error) fail("listings", error.message);
    return (data ?? []).map((l) => ({ id: l.id, lastmod: l.created_at ?? null }));
  }),

  /**
   * Public: every town that can carry a hub page (/town-hall/{town}) — the UNION of towns
   * with Town Hall topics and towns with venues, with per-town counts so callers (the
   * sitemap, the hub indexability rule) can decide which hubs are substantial enough to
   * list. Deduped by locality slug in JS since PostgREST has no DISTINCT-ON over an
   * ordered window here; topic-board labels win over raw venue locality spellings.
   */
  localities: publicProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    const [topicsRes, venuesRes] = (await Promise.all([
      db
        .from("town_hall_topics")
        .select("locality, locality_label, last_activity_at")
        .order("last_activity_at", { ascending: false })
        .limit(20000),
      db.from("venues").select("locality").not("locality", "is", null).limit(20000),
    ])) as [
      { data: { locality: string | null; locality_label: string | null; last_activity_at: string | null }[] | null; error: { message: string } | null },
      { data: { locality: string | null }[] | null; error: { message: string } | null },
    ];
    if (topicsRes.error) fail("localities", topicsRes.error.message);
    // Venue towns are additive — a venues read failure degrades to topic towns only.
    const seen = new Map<string, { locality: string; label: string; lastmod: string | null; topicCount: number; venueCount: number }>();
    for (const row of topicsRes.data ?? []) {
      const slug = row.locality;
      if (!slug) continue;
      const ex = seen.get(slug);
      if (ex) ex.topicCount += 1;
      else seen.set(slug, { locality: slug, label: row.locality_label ?? slug, lastmod: row.last_activity_at ?? null, topicCount: 1, venueCount: 0 });
    }
    for (const row of venuesRes.data ?? []) {
      const label = row.locality?.trim();
      if (!label) continue;
      let slug: string;
      try {
        slug = localitySlug(label);
      } catch {
        continue; // a locality that can't slug (e.g. all-symbol) can't have a hub URL
      }
      const ex = seen.get(slug);
      if (ex) ex.venueCount += 1;
      else seen.set(slug, { locality: slug, label, lastmod: null, topicCount: 0, venueCount: 1 });
    }
    return Array.from(seen.values());
  }),

  /**
   * Public: town × category combos that clear a minimum venue count — the source for the
   * /discover/{town}/{category} sitemap entries. Given the caller's set of discovery categories,
   * counts non-permanently-closed venues per (locality slug, category) in JS (PostgREST has no
   * GROUP BY here) and returns only combos with at least `minVenues`, so the sitemap never lists
   * a thin (noindex) discovery page. `label` is the raw venue locality so the caller can confirm
   * the slug round-trips; `lastmod` is the freshest venue in the combo.
   */
  discoverCombos: publicProcedure
    .input(
      z.object({
        categories: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
        minVenues: z.number().int().min(1).max(50).default(3),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venues")
        .select("locality, category, business_status, updated_at, created_at")
        .in("category", input.categories)
        .not("locality", "is", null)
        .limit(20000)) as {
        data: { locality: string | null; category: string | null; business_status: string | null; updated_at: string | null; created_at: string | null }[] | null;
        error: { message: string } | null;
      };
      if (error) fail("discover combos", error.message);
      const counts = new Map<string, { locality: string; label: string; category: string; venueCount: number; lastmod: string | null }>();
      for (const row of data ?? []) {
        if (row.business_status === "CLOSED_PERMANENTLY") continue;
        const label = row.locality?.trim();
        const category = row.category;
        if (!label || !category) continue;
        let slug: string;
        try {
          slug = localitySlug(label);
        } catch {
          continue; // a locality that can't slug can't have a discovery URL
        }
        const key = `${slug}::${category}`;
        const mod = row.updated_at ?? row.created_at ?? null;
        const ex = counts.get(key);
        if (ex) {
          ex.venueCount += 1;
          if (mod && (!ex.lastmod || mod > ex.lastmod)) ex.lastmod = mod;
        } else {
          counts.set(key, { locality: slug, label, category, venueCount: 1, lastmod: mod });
        }
      }
      return Array.from(counts.values()).filter((c) => c.venueCount >= input.minVenues);
    }),
});
