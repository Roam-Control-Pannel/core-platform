/**
 * Roam HQ reads span the whole schema, and the generated DB types lag it
 * (profile_posts, town_hall_*, events are untyped at time of writing). Rather than
 * pin every admin read to a partial type, we go through a deliberately loose
 * accessor — the same idiom the venueActivity / moderation routers already use.
 *
 * This is READ-only territory: the admin surface observes; it never writes user
 * data through here. The one privileged write path (the audit log, Phase 3) is
 * explicit and typed.
 */
import type { RoamClient } from "@roam/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LooseDb = { from: (table: string) => any };

/** View a (service-role) client as the loose accessor for cross-schema reads. */
export function loose(client: RoamClient): LooseDb {
  return client as unknown as LooseDb;
}

/**
 * Count rows in a table, optionally narrowed by a builder (e.g. a time window or a
 * status filter). Uses a head request so no rows travel — just the exact count.
 */
export async function countWhere(
  client: RoamClient,
  table: string,
  build?: (q: any) => any,
): Promise<number> {
  let q = loose(client).from(table).select("*", { count: "exact", head: true });
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw new Error(`admin: count ${table} failed: ${error.message}`);
  return (count as number | null) ?? 0;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const DAY_MS = 86_400_000;

/** ISO timestamp for `msAgo` milliseconds before now. */
export function isoAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}
