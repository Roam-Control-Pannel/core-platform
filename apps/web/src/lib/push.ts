/**
 * Browser-side Web Push capture helpers.
 *
 * This file deliberately does NOT import @roam/core/push: core can't be
 * browser-bundled under Turbopack (Node-ESM .js-suffix resolution breaks). The
 * one pure helper the browser needs — urlBase64ToUint8Array, to turn the VAPID
 * public key into the applicationServerKey BufferSource — is tiny and lives here
 * locally. The serialised-subscription SHAPE we produce ({endpoint, keys}) is the
 * exact shape @roam/core/push.parseWebToken validates server-side, so the two
 * stay in lockstep by contract even though the code isn't shared.
 *
 * subscribeWebPush() does the full capture dance and returns a registration
 * payload ready to hand to social.register, or throws with a human-readable
 * reason the component can surface.
 */

/** VAPID public key → Uint8Array applicationServerKey. Pure. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface WebPushRegistration {
  platform: "web";
  token: string;
}

/** True if this browser can do Web Push at all. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Register the SW, request permission, subscribe via PushManager, and return the
 * serialised registration. Throws Error(reason) on any failure (unsupported,
 * permission denied, missing VAPID key, subscribe failure) so the caller can show it.
 */
export async function subscribeWebPush(): Promise<WebPushRegistration> {
  if (!pushSupported()) {
    throw new Error("This browser does not support web push notifications.");
  }

  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapid) {
    throw new Error("Push is not configured (missing VAPID public key).");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  // Reuse an existing subscription if present, else create one.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    }));

  // PushSubscription.toJSON() gives { endpoint, keys: { p256dh, auth } } — exactly
  // the shape the server validates. Serialise the whole thing into `token`.
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }

  return {
    platform: "web",
    token: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }),
  };
}
