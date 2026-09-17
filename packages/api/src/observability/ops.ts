/**
 * The process-wide ops notifier. One sink per process, built from env, importable from anywhere
 * (server routes, routers, scheduled jobs) without plumbing it through the context.
 *
 *   ALERT_WEBHOOK_URL — Slack/Discord/Teams-style incoming webhook. Unset = alerts go to stderr.
 *   ALERT_SOURCE      — label in the message (defaults to "api"; jobs pass their own name).
 */
import { createAlertSink, installProcessAlertHooks, type OpsNotifier } from "./alerts.js";

const sink = createAlertSink({
  webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || null,
  source: process.env.ALERT_SOURCE?.trim() || "api",
});

/** Send an ops alert (deduped by key; never throws). */
export const notifyOps: OpsNotifier = sink.notifyOps;

/** Hook unhandled rejections / uncaught exceptions for this process (idempotent). */
export function installOpsHooks(): void {
  installProcessAlertHooks(notifyOps);
}

/** A job's failure, in one line: alert + stderr, then let the caller set the exit code. */
export async function reportJobFailure(job: string, e: unknown): Promise<void> {
  const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  console.error(`\n${job} failed:`, e instanceof Error ? e.message : e);
  await notifyOps({ key: `job.${job}`, title: `Scheduled job failed: ${job}`, detail });
}
