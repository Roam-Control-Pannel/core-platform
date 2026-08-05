/**
 * Roam HQ — privileged actions (the v2 "Act" surface).
 *
 * Each action performs the operation via the existing service-role plumbing (the 0029
 * moderation functions, the 0007/0008 claim functions, or a direct moderation_queue
 * resolve) AND writes an admin_audit_log row attributed to the acting staff member.
 * This closes the long-standing gap where moderation actions had no human on record
 * (moderation_queue.reviewed_by / venue_claims.reviewed_by were never set by a person).
 *
 * The caller (adminActions router) has already checked the actor's role — viewers are
 * observe-only and never reach here.
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";

/** Who is acting, for attribution. `email` is a durable snapshot (may be null). */
export interface AdminActor {
  id: string;
  email: string | null;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  detail?: Record<string, unknown>;
}

/** Append an audit row. Best-effort-safe: throws only on a hard DB error. */
export async function recordAudit(
  client: RoamClient,
  actor: AdminActor,
  input: AuditInput,
): Promise<void> {
  const { error } = await loose(client)
    .from("admin_audit_log")
    .insert({
      actor_id: actor.id,
      actor_email: actor.email,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      detail: input.detail ?? {},
    });
  if (error) throw new Error(`admin: audit write failed: ${error.message}`);
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;

/** Ban or un-ban a user (also suspends/restores their venues), then audit. */
export async function setUserBanned(
  client: RoamClient,
  actor: AdminActor,
  userId: string,
  banned: boolean,
): Promise<void> {
  const rpc = client.rpc.bind(client) as unknown as Rpc;
  const { error } = await rpc("moderate_ban_profile", { p_user_id: userId, p_banned: banned });
  if (error) throw new Error(`admin: ${banned ? "ban" : "unban"} failed: ${error.message}`);
  await recordAudit(client, actor, {
    action: banned ? "ban_user" : "unban_user",
    entityType: "profile",
    entityId: userId,
  });
}

/** Suspend or restore a venue (hide/show in public discovery), then audit. */
export async function setVenueSuspended(
  client: RoamClient,
  actor: AdminActor,
  venueId: string,
  suspended: boolean,
): Promise<void> {
  const rpc = client.rpc.bind(client) as unknown as Rpc;
  const { error } = await rpc("moderate_set_venue_suspended", { p_venue_id: venueId, p_suspended: suspended });
  if (error) throw new Error(`admin: ${suspended ? "suspend" : "restore"} failed: ${error.message}`);
  await recordAudit(client, actor, {
    action: suspended ? "suspend_venue" : "restore_venue",
    entityType: "venue",
    entityId: venueId,
  });
}

/** Approve a venue claim (confers ownership via 0007), then audit. */
export async function approveClaim(
  client: RoamClient,
  actor: AdminActor,
  claimId: string,
): Promise<void> {
  const rpc = client.rpc.bind(client) as unknown as Rpc;
  const { error } = await rpc("approve_venue_claim", { target_claim_id: claimId });
  if (error) throw new Error(`admin: claim approval failed: ${error.message}`);
  await recordAudit(client, actor, { action: "approve_claim", entityType: "claim", entityId: claimId });
}

/** Reject a venue claim (via 0008), then audit. */
export async function rejectClaim(
  client: RoamClient,
  actor: AdminActor,
  claimId: string,
): Promise<void> {
  const rpc = client.rpc.bind(client) as unknown as Rpc;
  const { error } = await rpc("reject_venue_claim", { target_claim_id: claimId });
  if (error) throw new Error(`admin: claim rejection failed: ${error.message}`);
  await recordAudit(client, actor, { action: "reject_claim", entityType: "claim", entityId: claimId });
}

/**
 * Resolve a moderation_queue item — set its status and stamp the reviewer (finally
 * populating reviewed_by/reviewed_at with a real person), then audit.
 */
export async function resolveReport(
  client: RoamClient,
  actor: AdminActor,
  reportId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const { error } = await loose(client)
    .from("moderation_queue")
    .update({ status: decision, reviewed_by: actor.id, reviewed_at: new Date().toISOString() })
    .eq("id", reportId);
  if (error) throw new Error(`admin: resolve report failed: ${error.message}`);
  await recordAudit(client, actor, {
    action: "resolve_report",
    entityType: "report",
    entityId: reportId,
    detail: { decision },
  });
}
