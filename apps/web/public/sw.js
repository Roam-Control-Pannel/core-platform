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
  // STUB (dispatch slice fills this): parse event.data JSON -> showNotification.
  // Intentionally a no-op during capture; a subscription is still valid without it.
  void event;
});

self.addEventListener("notificationclick", (event) => {
  // STUB (dispatch slice fills this): focus/open the relevant venue or post URL.
  void event;
});
