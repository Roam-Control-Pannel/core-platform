/**
 * Roam HQ — supplier (orgs) moderation (holistic plan Phase 1.8).
 *
 * C3 let a live F2G member create a supplier as a draft, pending-moderation row, and the orgs_read
 * hard gate (0136) hides it from the public until staff approve — but nothing let staff approve:
 * no list of pending suppliers, no action, no audit. Submissions could only ever pile up. This is
 * the missing half:
 *
 *   pendingSuppliers  — every org awaiting a decision (moderation 'pending' or 'auto_flagged'),
 *                       oldest first, with the owner's public handle for context.
 *   moderateSupplier  — approve (moderation 'approved' + status 'live': the public gate opens) or
 *                       reject (moderation 'rejected'; status untouched — the owner keeps their draft
 *                       and can resubmit after editing). Attributed + audited like every HQ action.
 *
 * Service-role reads/writes under adminProcedure (owners cannot touch status/moderation — the 0136
 * column guard). Suppliers are global (no channel_id yet — plan §6), so this queue is site-wide.
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";
import { recordAudit, type AdminActor } from "./actions.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PendingSupplier {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  website: string | null;
  locality: string | null;
  logoUrl: string | null;
  status: string;
  moderation: string;
  ownerId: string | null;
  ownerHandle: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function pendingSuppliers(client: RoamClient, limit = 50): Promise<{ items: PendingSupplier[]; pendingCount: number }> {
  const { data, error, count } = await loose(client)
    .from("orgs")
    .select("id, name, slug, description, category, website, locality, logo_url, status, moderation, owner_id, created_at, updated_at, profiles:owner_id(handle)", { count: "exact" })
    .in("moderation", ["pending", "auto_flagged"])
    .neq("status", "removed")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`admin: pending suppliers read failed: ${error.message}`);
  const rows = (data ?? []) as any[];
  return {
    pendingCount: typeof count === "number" ? count : rows.length,
    items: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      slug: String(r.slug),
      description: r.description ?? null,
      category: String(r.category ?? "supplier"),
      website: r.website ?? null,
      locality: r.locality ?? null,
      logoUrl: r.logo_url ?? null,
      status: String(r.status),
      moderation: String(r.moderation),
      ownerId: r.owner_id ?? null,
      ownerHandle: r.profiles?.handle ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    })),
  };
}

export type SupplierDecision = "approved" | "rejected";

export async function moderateSupplier(
  client: RoamClient,
  actor: AdminActor,
  args: { orgId: string; decision: SupplierDecision; note?: string | undefined },
): Promise<{ orgId: string; decision: SupplierDecision; status: string }> {
  const { data: org, error: readErr } = await loose(client)
    .from("orgs")
    .select("id, status, moderation")
    .eq("id", args.orgId)
    .maybeSingle();
  if (readErr) throw new Error(`admin: supplier read failed: ${readErr.message}`);
  if (!org) throw new Error("admin: supplier not found");
  if (org.status === "removed") throw new Error("admin: a removed supplier cannot be moderated");

  // Approve opens the public gate (orgs_read needs approved + live). Reject leaves the owner's draft
  // in place so they can fix it and resubmit — it just stays invisible.
  const patch: Record<string, unknown> =
    args.decision === "approved" ? { moderation: "approved", status: "live" } : { moderation: "rejected" };

  const { error: writeErr } = await loose(client).from("orgs").update(patch).eq("id", args.orgId);
  if (writeErr) throw new Error(`admin: supplier moderation write failed: ${writeErr.message}`);

  await recordAudit(client, actor, {
    action: "moderate_supplier",
    entityType: "org",
    entityId: args.orgId,
    detail: { decision: args.decision, from: { status: org.status, moderation: org.moderation }, note: args.note ?? null },
  });

  return { orgId: args.orgId, decision: args.decision, status: args.decision === "approved" ? "live" : String(org.status) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
