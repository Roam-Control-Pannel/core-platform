/**
 * Transit runtime guard — the cost + abuse controls around the paid Translink calls.
 *
 * Translink's Open Data licence is fair-use limited (~3,000 requests/day). Three guards keep
 * us safely inside it, all IN-MEMORY (no migration, no DB round-trip on a latency-sensitive
 * realtime read):
 *
 *   1. Board cache — a snapped-coordinate key → board, TTL DEPARTURES_TTL_MS. A hit serves for
 *      free, so a crowd looking at the same place costs one lookup, not one-per-viewer.
 *   2. Daily budget — a UTC-day request counter capped at TRANSLINK_DAILY_BUDGET. Claimed once
 *      per outbound EFA call (a "nearby departures" answer costs up to two: CoordInfo + DM), so
 *      the ceiling is in EFA-requests, comfortably under the licence limit.
 *   3. Per-client throttle — a sliding window per forwarded client key, so one client can't
 *      drain the daily budget on its own.
 *
 * CAVEAT (deliberate, documented): this state is per-process. On a single API instance (our
 * current Railway deploy) it is exact; if we ever horizontally scale the API, the effective
 * ceiling multiplies by the instance count. The budget is set with enough headroom that this
 * is safe for launch, and the honest fix (a shared counter, like places' claim_places_fetch_quota
 * RPC) is a clean follow-up if/when we scale out. Documenting it here so it is a known limit,
 * not a silent one.
 */
import { transit } from "@roam/core";

/** Per-client sliding-window limit: at most this many answers per window, per forwarded key. */
const CLIENT_LIMIT = 20;
const CLIENT_WINDOW_MS = 60_000;

/** Cap on the throttle map's size, so an adversary rotating keys can't grow it unbounded. */
const MAX_TRACKED_CLIENTS = 5_000;

const DAY_MS = 86_400_000;

/** What a paid answer's admission check returned. */
export type Admission = { ok: true } | { ok: false; reason: "throttled" | "budget-exhausted" };

/** The cached board shape is whatever the router stores; kept generic so the guard is board-agnostic. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * The guard is a single long-lived instance (constructed once in the router module). All state
 * lives on it; nothing is global, so a test can spin up a fresh guard with its own clock.
 */
export class TransitGuard<TBoard> {
  private cache = new Map<string, CacheEntry<TBoard>>();
  private clientHits = new Map<string, number[]>();
  private budgetDay = -1;
  private budgetUsed = 0;

  /** Injectable clock so tests are deterministic; defaults to the real wall clock. */
  constructor(private now: () => number = () => Date.now()) {}

  /** Roll the daily budget over when the UTC day changes. */
  private rollDay(): void {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.budgetDay) {
      this.budgetDay = day;
      this.budgetUsed = 0;
    }
  }

  /** Return a cached board if present and unexpired, else null. */
  getCached(key: string): TBoard | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.value;
  }

  /** Cache a board for DEPARTURES_TTL_MS. */
  setCached(key: string, value: TBoard): void {
    this.cache.set(key, { value, expiresAt: this.now() + transit.DEPARTURES_TTL_MS });
  }

  /**
   * Per-answer admission: enforce the per-client sliding window, then confirm budget remains.
   * Does NOT spend budget (call claimRequest per outbound EFA call for that) — this is the cheap
   * upfront gate so we reject before doing any work. `clientKey` null (e.g. local dev) skips the
   * throttle but still respects the budget.
   */
  admit(clientKey: string | null): Admission {
    this.rollDay();
    if (this.budgetUsed >= transit.TRANSLINK_DAILY_BUDGET) {
      return { ok: false, reason: "budget-exhausted" };
    }
    if (clientKey && !this.throttleOk(clientKey)) {
      return { ok: false, reason: "throttled" };
    }
    return { ok: true };
  }

  /**
   * Claim one unit of the daily budget for one outbound EFA call. Returns false when the ceiling
   * is reached (the caller then degrades gracefully rather than calling Translink).
   */
  claimRequest(): boolean {
    this.rollDay();
    if (this.budgetUsed >= transit.TRANSLINK_DAILY_BUDGET) return false;
    this.budgetUsed += 1;
    return true;
  }

  /** Sliding-window check + record for one client key. */
  private throttleOk(clientKey: string): boolean {
    const now = this.now();
    const cutoff = now - CLIENT_WINDOW_MS;
    const hits = (this.clientHits.get(clientKey) ?? []).filter((t) => t > cutoff);
    if (hits.length >= CLIENT_LIMIT) {
      this.clientHits.set(clientKey, hits);
      return false;
    }
    hits.push(now);
    this.clientHits.set(clientKey, hits);
    // Bound the map: if it grows past the cap, drop the oldest-touched keys wholesale. Coarse
    // but adversary-proof — a rotating-key flood can't leak memory.
    if (this.clientHits.size > MAX_TRACKED_CLIENTS) {
      this.clientHits.clear();
    }
    return true;
  }
}
