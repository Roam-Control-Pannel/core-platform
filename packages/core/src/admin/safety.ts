/**
 * Roam HQ — the trust & safety queue (read side).
 *
 * moderation_queue (0003) collects auto-flags and user reports awaiting human review.
 * Nothing surfaces this today — reviewed_by has always been null because there was no
 * staff surface to act. v1 shows the open queue; Phase 3 wires the resolve actions.
 */
import type { RoamClient } from "@roam/db";
import { countWhere, loose } from "./loose.js";

export interface QueueItem {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  reporterId: string | null;
  detail: string | null;
  status: string;
  createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Open (pending) moderation items, oldest first (longest-waiting at the top). */
export async function getModerationQueue(
  client: RoamClient,
  limit = 50,
): Promise<{ pendingCount: number; items: QueueItem[] }> {
  const [pendingCount, res] = await Promise.all([
    countWhere(client, "moderation_queue", (q) => q.eq("status", "pending")),
    loose(client)
      .from("moderation_queue")
      .select("id, entity_type, entity_id, reason, reporter_id, detail, status, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit),
  ]);
  if (res.error) throw new Error(`admin: moderation queue failed: ${res.error.message}`);

  const items = ((res.data ?? []) as any[]).map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    reason: r.reason,
    reporterId: r.reporter_id ?? null,
    detail: r.detail ?? null,
    status: r.status,
    createdAt: r.created_at,
  }));
  return { pendingCount, items };
}

export interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Recent privileged-action audit trail, newest first. */
export async function getAuditLog(
  client: RoamClient,
  limit = 30,
): Promise<AuditEntry[]> {
  const { data, error } = await loose(client)
    .from("admin_audit_log")
    .select("id, actor_email, action, entity_type, entity_id, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`admin: audit log read failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    actorEmail: r.actor_email ?? null,
    action: r.action,
    entityType: r.entity_type ?? null,
    entityId: r.entity_id ?? null,
    detail: (r.detail ?? {}) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
