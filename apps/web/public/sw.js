/*
 * Roam web service worker.
 *
 * Capture slice: this file exists so the browser can register a service worker,
 * which is a prerequisite for PushManager.subscribe(). It claims clients on
 * activate so a freshly-registered worker controls the page without a reload.
 *
 * The 'push' and 'notificationclick' handlers are STUBS for now — they become
 * real in the dispatch slice (3b-push dispatch), when the server actually sends
 * encrypted Web Push payloads. A registered worker with a no-op push handler
 * still captures a valid subscription; delivery is the part that needs the
 * handler body. We register them now (empty) so the contract is visible and the
 * dispatch slice only has to fill bodies, not wire events.
 */

self.addEventListener("install", () => {
  // Activate immediately rather than waiting for old workers to release.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of open clients so the first subscribe doesn't need a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Parse the JSON payload dispatch.ts sends: { title, body, url, venueId }. Be
  // defensive — a malformed or bodiless push must not throw inside the worker, so
  // fall back to a generic notification rather than dropping it.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = {};
  }

  const title = payload.title || "Roam";
  const options = {
    body: payload.body || "",
    // Stash the deep-link target so notificationclick can open it. Keep venueId too
    // in case a later slice wants richer routing.
    data: { url: payload.url || "/", venueId: payload.venueId || null },
  };

  // Keep the worker alive until the notification is shown.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  // Close the notification, then focus an already-open Roam tab if there is one,
  // otherwise open the deep-link target. Standard matchAll -> focus-or-openWindow.
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          // Focus any open Roam window; navigate it to the target if we can.
          if ("focus" in client) {
            client.focus();
            if ("navigate" in client && target !== "/") {
              client.navigate(target).catch(() => {});
            }
            return undefined;
          }
        }
        // No open window — open a new one at the target.
        if (self.clients.openWindow) {
          return self.clients.openWindow(target);
        }
        return undefined;
      }),
  );
});
