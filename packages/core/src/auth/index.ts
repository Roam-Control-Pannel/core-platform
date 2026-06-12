/**
 * Auth — pure helpers for the token handoff that auth flows leave in a URL.
 *
 * No React, no Expo, no Supabase: just the string logic that turns a redirect URL
 * into tokens, kept here so it's testable in isolation and shared by any shell that
 * needs it. The transport (deep-link listener on native, browser URL on web) and the
 * session exchange (supabase.auth.setSession) are the caller's concern — this module
 * only answers "does this URL carry an auth token pair, and if so what is it?".
 */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Pull an access/refresh token pair out of a redirect URL's fragment, or null.
 *
 * Supabase's implicit-flow email confirmation returns the session in the URL
 * FRAGMENT (after `#`), e.g. `native:///#access_token=…&refresh_token=…&type=signup`.
 * We parse the fragment, never the path — so the number of leading slashes is
 * irrelevant (the native deep link arrives as `native:///#…`, three slashes, and
 * this still works). Both tokens must be present and non-empty or we return null;
 * a partial or token-less URL (e.g. the dev-client launch URL, which carries a
 * `?url=` QUERY and no fragment) is not an auth callback and yields null.
 *
 * example: "native:///#access_token=a&refresh_token=r" -> { accessToken: "a", refreshToken: "r" }
 * example: "native://#access_token=a&refresh_token=r"  -> { accessToken: "a", refreshToken: "r" }
 * example: "native:///#access_token=a"                 -> null (refresh token missing)
 * example: "myapp://expo-development-client/?url=http://x" -> null (no fragment)
 */
export function parseAuthTokensFromUrl(url: string): AuthTokens | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;

  const fragment = url.slice(hashIndex + 1);
  if (!fragment) return null;

  const params = new URLSearchParams(fragment);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");

  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}
