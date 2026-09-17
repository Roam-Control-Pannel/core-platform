/**
 * Ops alerts — the ONE place a "someone should look at this" signal leaves the process.
 *
 * Before this (holistic plan Phase 1.4) nothing on any path alerted anyone: the September 2026
 * blank-storefront incident was found by a user. This module posts a short message to a webhook
 * (`ALERT_WEBHOOK_URL` — Slack-, Discord- or Teams-shaped receivers all accept a JSON body with a
 * `text`; we also send `content` for Discord) and is deliberately tiny and dependency-free:
 *
 *   - never throws and never awaits longer than a few seconds — an alert must not take the
 *     request or the job down with it;
 *   - de-duplicates by `key` within a window, so a failing loop sends one message, not a thousand;
 *   - is a no-op when the URL is unset (dev, tests) — it logs the alert to stderr instead, so the
 *     signal is never silently lost.
 *
 * Wired at: the API's unhandled-error hooks and tRPC INTERNAL errors (server.ts), the channel
 * kill-switch (channels.ts — a branded host serving maintenance is an incident), and the scheduled
 * jobs' failure paths. Error TRACKING (stack aggregation, releases) is a later choice — Sentry or
 * similar slots in behind the same `notifyOps` call.
 */

export interface OpsAlert {
  /** Stable dedupe key, e.g. "trpc.internal:venues.storefrontNear" or "job.fsa-sync". */
  key: string;
  title: string;
  detail?: string | undefined;
  /** Severity only affects the message prefix; every alert goes to the same receiver. */
  severity?: "warn" | "error" | undefined;
}

export interface AlertSink {
  webhookUrl: string | null;
  /** Service label in the message (api / web / job name). */
  source: string;
  /** Injectable for tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Dedupe window; default 10 minutes. */
  dedupeMs?: number;
}

const DEFAULT_DEDUPE_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 4_000;

/** PURE: the message body a receiver gets. Exported for tests. */
export function formatAlert(source: string, alert: OpsAlert, at: Date): { text: string; content: string } {
  const sev = (alert.severity ?? "error").toUpperCase();
  const lines = [`[${sev}] ${source} — ${alert.title}`];
  if (alert.detail) lines.push(alert.detail.slice(0, 1_500));
  lines.push(`key: ${alert.key} · ${at.toISOString()}`);
  const text = lines.join("\n");
  return { text, content: text };
}

/**
 * Build a sink. One per process (module-level in server.ts / each job); the dedupe memory is per
 * sink, so a restart resets it — acceptable, a restart is itself worth a message.
 */
export function createAlertSink(cfg: AlertSink) {
  const lastSent = new Map<string, number>();
  const now = cfg.now ?? (() => Date.now());
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const dedupeMs = cfg.dedupeMs ?? DEFAULT_DEDUPE_MS;

  /** Returns true when a message was (attempted to be) sent, false when deduped or disabled. */
  async function notifyOps(alert: OpsAlert): Promise<boolean> {
    try {
      const t = now();
      const prev = lastSent.get(alert.key);
      if (prev !== undefined && t - prev < dedupeMs) return false;
      lastSent.set(alert.key, t);
      // Bound the memory: drop keys older than the window once the map grows.
      if (lastSent.size > 500) {
        for (const [k, v] of lastSent) if (t - v >= dedupeMs) lastSent.delete(k);
      }

      const body = formatAlert(cfg.source, alert, new Date(t));
      if (!cfg.webhookUrl) {
        console.error(`[alert:${cfg.source}] ${body.text.replace(/\n/g, " | ")}`);
        return true;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetchImpl(cfg.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) console.error(`[alert:${cfg.source}] webhook answered ${res.status} for ${alert.key}`);
      } finally {
        clearTimeout(timer);
      }
      return true;
    } catch (e) {
      console.error(`[alert:${cfg.source}] failed to send ${alert.key}: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
  }

  return { notifyOps };
}

export type OpsNotifier = ReturnType<typeof createAlertSink>["notifyOps"];

/** Process-wide hooks: the last line of defence. Idempotent per process. */
let hooked = false;
export function installProcessAlertHooks(notifyOps: OpsNotifier): void {
  if (hooked) return;
  hooked = true;
  process.on("unhandledRejection", (reason) => {
    void notifyOps({
      key: "process.unhandledRejection",
      title: "Unhandled promise rejection",
      detail: reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason),
    });
  });
  process.on("uncaughtException", (err) => {
    void notifyOps({
      key: "process.uncaughtException",
      title: "Uncaught exception (process will restart)",
      detail: `${err.message}\n${err.stack ?? ""}`,
    });
  });
}
