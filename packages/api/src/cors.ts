/**
 * CORS origin allow-listing for the standalone API.
 *
 * The co-brand channel model keeps minting new branded hostnames — every channel domain (e.g.
 * nifood2go.roam-local.com) is a distinct browser origin, yet they all call this one API. An
 * exact-match allowlist would silently CORS-block each new storefront the moment it's mapped, so an
 * entry may carry a single `*` standing for the subdomain label(s):
 *
 *   https://*.roam-local.com      → any subdomain of the roam-owned base, over https
 *   http://localhost:3000         → exact, matched verbatim (the common case)
 *
 * Matches are fully anchored, so a wildcard entry can never be satisfied by a look-alike suffix
 * (`https://roam-local.com.evil.com` does NOT match `https://*.roam-local.com`). Kept pure and
 * transport-free so it unit-tests without booting the server.
 */

/** Compile one allowlist entry into an origin predicate (exact, or a `*` subdomain wildcard). */
export function compileOriginMatcher(entry: string): (origin: string) => boolean {
  if (!entry.includes("*")) return (origin) => origin === entry;
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.replace(/\\\*/g, "[a-z0-9-]+(?:\\.[a-z0-9-]+)*")}$`, "i");
  return (origin) => re.test(origin);
}

/** Build an `isOriginAllowed(origin)` predicate over a list of allowlist entries. */
export function makeOriginAllowed(entries: string[]): (origin: string) => boolean {
  const matchers = entries.map(compileOriginMatcher);
  return (origin: string) => matchers.some((match) => match(origin));
}
