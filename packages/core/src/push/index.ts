/**
 * Push subscription registration logic. Pure validation rules.
 *
 * A person registers ONE push subscription per device/browser. The grain is
 * per-PERSON, not per-venue: push_subscriptions is keyed (profile_id, token),
 * while WHICH venues they get pushes for is the separate `follows` edge. Dispatch
 * (a later slice) fans a venue's post out by joining follows x push_subscriptions on
 * profile_id. So registration here is transport-agnostic and venue-agnostic: it just
 * validates "this is a well-formed subscription for this platform".
 *
 * The rules live here, once — the API calls them server-side before the upsert. The
 * browser does NOT import this module (core can't be browser-bundled under Turbopack's
 * Node-ESM .js-suffix resolution); the web app re-implements the one tiny pure key
 * helper (urlBase64ToUint8Array) locally. This module is the shared/server truth.
 */

export type PushPlatform = "web" | "ios" | "android";

export interface SubscriptionRegistration {
  platform: PushPlatform;
  token: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const PLATFORMS: ReadonlySet<PushPlatform> = new Set<PushPlatform>([
  "web",
  "ios",
  "android",
]);

export interface WebPushToken {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function parseWebToken(token: string): WebPushToken | null {
  let raw: unknown;
  try {
    raw = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const endpoint = (raw as { endpoint?: unknown }).endpoint;
  const keys = (raw as { keys?: unknown }).keys;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return null;
  }
  if (typeof keys !== "object" || keys === null) return null;

  const p256dh = (keys as { p256dh?: unknown }).p256dh;
  const auth = (keys as { auth?: unknown }).auth;
  if (
    typeof p256dh !== "string" ||
    p256dh.length === 0 ||
    typeof auth !== "string" ||
    auth.length === 0
  ) {
    return null;
  }

  return { endpoint, keys: { p256dh, auth } };
}

export function validateRegistration(
  input: SubscriptionRegistration,
): ValidationResult {
  const errors: string[] = [];

  if (!PLATFORMS.has(input.platform)) {
    errors.push("Unknown push platform.");
  }

  const token = input.token?.trim() ?? "";
  if (token.length === 0) {
    errors.push("A subscription must carry a non-empty token.");
  }

  if (input.platform === "web" && token.length > 0) {
    if (!parseWebToken(token)) {
      errors.push(
        "A web subscription token must be a serialised PushSubscription " +
          "with an https endpoint and p256dh + auth keys.",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
