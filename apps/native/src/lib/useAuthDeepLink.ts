/**
 * useAuthDeepLink — catch the email-confirmation deep link and turn it into a session.
 *
 * Sign-up with email confirmation ON returns no session (AuthSheet shows "check your
 * email"); the user confirms via the emailed link, which Supabase redirects to the
 * app's native:// scheme with the session in the URL fragment
 * (`native:///#access_token=…&refresh_token=…`). This hook listens for that link —
 * both the cold-start case (app launched BY the link, via getInitialURL) and the warm
 * case (app already open, foregrounded by the link, via the "url" event) — extracts
 * the tokens with the pure @roam/core/auth parser, and calls setSession.
 *
 * That setSession fires onAuthStateChange in TrpcProvider, which sets the session and
 * lets the tRPC client carry the JWT — the exact same path a password sign-in takes.
 * So the user lands signed in on Discover; the follow they wanted is now one ungated
 * tap away. We deliberately do NOT auto-fire the held follow: the intent lived in
 * screen state that an email round-trip (and possible cold start) discards, and
 * silently mutating minutes later off a backgrounded intent is surprising. Session-
 * only resume matches the web surface and keeps this path stateless and predictable.
 *
 * Mounted once, inside TrpcProvider (it needs the same Supabase singleton). Non-auth
 * URLs — including the dev-client launch URL — parse to null and are ignored.
 */
import { useEffect } from "react";
import * as Linking from "expo-linking";
import { parseAuthTokensFromUrl } from "@roam/core/auth";
import { getSupabaseNative } from "./supabase";

export function useAuthDeepLink(): void {
  useEffect(() => {
    let cancelled = false;

    async function handleUrl(url: string | null): Promise<void> {
      if (!url) return;
      const tokens = parseAuthTokensFromUrl(url);
      if (!tokens) return; // not an auth callback (e.g. the dev-client launch URL)

      const { error } = await getSupabaseNative().auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      // A stale/invalid link just fails to establish a session — no crash, no state
      // change (onAuthStateChange never fires). The user stays signed out and can
      // retry. We don't surface an error here: this runs ambiently, not from a tap.
      if (error && !cancelled) {
        console.warn("Deep-link sign-in failed:", error.message);
      }
    }

    // Cold start: the app was launched by the confirmation link.
    void Linking.getInitialURL().then((url) => {
      if (!cancelled) void handleUrl(url);
    });

    // Warm: the app was already running and foregrounded by the link.
    const sub = Linking.addEventListener("url", (e) => void handleUrl(e.url));

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
}
