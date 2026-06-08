/**
 * Follower-push dispatch — the send orchestration for 3b-push DISPATCH.
 *
 * WHERE THIS LIVES (and why not core): web-push is a Node-only library (it signs
 * VAPID JWTs and opens https sockets), so it cannot live in @roam/core, which is
 * framework/transport-agnostic by law (ARCHITECTURE.md). Signing + sending is an
 * API-layer capability. The RULES this leans on still live in core and are reused,
 * not reimplemented: push.parseWebToken (is a stored token a well-formed web
 * subscription?) and — in the caller, posts.create — posts.requiresPushCredit and
 * credits.consumeForSend. This module adds NO rule; it is pure orchestration:
 * fan out, sign, send, prune dead subscriptions, tally.
 *
 * THE FAN-OUT: a venue's post targets its followers' devices. follows (follower_id
 * -> venue_id) gives the profiles; push_subscriptions (profile_id, token) gives
 * their devices. There is no direct FK between follows and push_subscriptions, so
 * we do two reads rather than fight a PostgREST embed across an absent relationship:
 * (1) follower ids for the venue, (2) web subscriptions for those profiles. Reads
 * run under the SERVICE client (RLS-bypassed) because dispatch legitimately fans a
 * post out across OTHER people's subscriptions — no user-scoped client could.
 *
 * DEAD SUBSCRIPTIONS: a push endpoint that returns 404/410 is gone for good (the
 * browser unsubscribed / the push service expired it). We delete that
 * push_subscriptions row so the table self-heals. Any other send failure is counted
 * but the row is kept (it may be transient). One bad send never aborts the fan-out.
 *
 * CREDITS: deliberately NOT consumed here. The credit gate is a precondition in the
 * caller (posts.create): per the slice decision, a follower_push publish is BLOCKED
 * unless the venue can afford it, so the post is never created on an empty balance.
 * Keeping consume out of this loop keeps the send a pure I/O fan-out.
 */
import webpush, { WebPushError, type PushSubscription } from "web-push";
import type { RoamClient } from "@roam/db";
import { push } from "@roam/core";

/** VAPID config the send needs. Read from env at the call boundary (server-only). */
export interface VapidConfig {
  /** 'mailto:' address or https URL — the VAPID JWT `sub` claim. */
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** The notification content fanned out to every follower device. */
export interface PushDispatchPayload {
  venueId: string;
  /** Deep-link target the service worker opens on notificationclick. */
  url: string;
  title: string;
  body: string;
}

/** Outcome tally — returned to the caller (and prod logs) so a dispatch is auditable. */
export interface DispatchResult {
  /** Candidate web subscriptions found across all followers. */
  candidates: number;
  /** Successful sends (push service accepted). */
  sent: number;
  /** Failed sends that were NOT a dead-endpoint prune (kept for retry/transient). */
  failed: number;
  /** Subscriptions deleted because the endpoint was gone (404/410). */
  pruned: number;
  /** Stored tokens that were not well-formed web subscriptions (skipped, not sent). */
  skipped: number;
}

/** True for the push-service status codes that mean "this endpoint is gone for good". */
function isDeadEndpoint(err: unknown): boolean {
  return (
    err instanceof WebPushError &&
    (err.statusCode === 404 || err.statusCode === 410)
  );
}

/**
 * Fan a published follower_push post out to every web device of every follower.
 *
 * Configures VAPID once, resolves the follower set, sends per subscription, prunes
 * dead endpoints, and returns a tally. Never throws for an individual bad send —
 * a single failure must not deny the rest of the followers their notification.
 * (A catastrophic failure — e.g. the follower query itself erroring — DOES throw,
 * so the caller can surface that the dispatch did not run.)
 */
export async function dispatchFollowerPush(
  service: RoamClient,
  vapid: VapidConfig,
  payload: PushDispatchPayload,
): Promise<DispatchResult> {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  // (1) Followers of this venue.
  const { data: followRows, error: followErr } = await service
    .from("follows")
    .select("follower_id")
    .eq("venue_id", payload.venueId);
  if (followErr) {
    throw new Error(`Dispatch failed to load followers: ${followErr.message}`);
  }
  const followerIds = (followRows ?? []).map((r) => r.follower_id);
  if (followerIds.length === 0) {
    return { candidates: 0, sent: 0, failed: 0, pruned: 0, skipped: 0 };
  }

  // (2) Web subscriptions for those followers (native is out of scope this slice).
  const { data: subRows, error: subErr } = await service
    .from("push_subscriptions")
    .select("id, token")
    .in("profile_id", followerIds)
    .eq("platform", "web")
    .eq("consent", true);
  if (subErr) {
    throw new Error(`Dispatch failed to load subscriptions: ${subErr.message}`);
  }
  const subscriptions = subRows ?? [];

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    venueId: payload.venueId,
  });

  const result: DispatchResult = {
    candidates: subscriptions.length,
    sent: 0,
    failed: 0,
    pruned: 0,
    skipped: 0,
  };

  for (const row of subscriptions) {
    // Reuse core's tolerant parser — a malformed stored token is skipped, not fatal.
    const parsed = push.parseWebToken(row.token);
    if (!parsed) {
      result.skipped += 1;
      continue;
    }
    const subscription: PushSubscription = {
      endpoint: parsed.endpoint,
      keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth },
    };

    try {
      await webpush.sendNotification(subscription, body);
      result.sent += 1;
    } catch (err) {
      if (isDeadEndpoint(err)) {
        const { error: delErr } = await service
          .from("push_subscriptions")
          .delete()
          .eq("id", row.id);
        if (!delErr) result.pruned += 1;
        else result.failed += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
