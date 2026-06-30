/**
 * Anonymous discovery meter — the "browse freely, then sign up" gate for venue discovery.
 *
 * An anonymous visitor can explore their CURRENT location plus up to 5 distinct SEARCHED
 * locations per session; beyond that, opening a new searched place asks them to create an
 * account. Only `search`-sourced places are metered — the user's own location and the
 * suggested/saved/default centres are always free. A place already opened this session stays
 * open (revisiting it doesn't burn another slot).
 *
 * Session-scoped (sessionStorage), so it resets per tab/session — a soft nudge, not a hard wall.
 * The real cost backstop is the server-side Places budget + per-client rate limit; this is the
 * product-side meter that converts heavy anonymous browsing into sign-ups.
 */
const KEY = "roam:anon:searched";
export const ANON_SEARCH_LIMIT = 5;

interface PlaceLike {
  lat: number;
  lng: number;
  source?: string;
}

/** Coarse key (~1km cell) so tiny coordinate jitter for the same place doesn't burn two slots. */
function placeKey(p: PlaceLike): string {
  return `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(keys: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(keys));
  } catch {
    /* private mode / quota — best-effort */
  }
}

/** Whether an anonymous user may open this place (true for non-search places and ones already opened). */
export function anonCanOpen(p: PlaceLike): boolean {
  if (p.source !== "search") return true;
  const keys = read();
  if (keys.includes(placeKey(p))) return true;
  return keys.length < ANON_SEARCH_LIMIT;
}

/** Record an opened searched place (idempotent, capped). Returns remaining searched-location allowance. */
export function anonRecordOpen(p: PlaceLike): number {
  if (p.source !== "search") return Math.max(0, ANON_SEARCH_LIMIT - read().length);
  const keys = read();
  const k = placeKey(p);
  if (!keys.includes(k) && keys.length < ANON_SEARCH_LIMIT) {
    keys.push(k);
    write(keys);
  }
  return Math.max(0, ANON_SEARCH_LIMIT - keys.length);
}

/** How many distinct searched locations the anonymous user has opened this session. */
export function anonSearchedCount(): number {
  return read().length;
}
