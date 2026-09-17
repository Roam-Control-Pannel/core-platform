/**
 * Roam HQ — roster member status actions (holistic plan Phase 1.2: the "live" spine).
 *
 * Until this landed nothing ever wrote `status = 'live'` — the invite flow writes `invited`, the claim
 * definer writes `claimed`, and every member entitlement (directory, jobs composer, supplier posting)
 * requires `live`. So no member could ever reach a member-only feature. This is the staff-operated
 * transition (Phase 2 adds self-serve activation by membership number, using the same rule table):
 *
 *   setMemberStatus — move a channel member to `live`, `lapsed` or `removed`, subject to the
 *     membership state machine (@roam/core/membership.canTransition). Going `live` additionally
 *     requires a bound venue (a live member with nothing to list is meaningless) — the venue link is
 *     the reviewer's job first (B4b). Every change is attributed + audited like the rest of HQ.
 *
 * `live` set here does NOT set `claimed_by`: the entitlements key on `claimed_by = auth.uid()` as well
 * as status, so a member marked live by staff still needs to claim/activate to post — but they ARE
 * counted, listed and ranked as a member from this moment.
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";
import { recordAudit, type AdminActor } from "./actions.js";
import { getChannelByKey } from "../channels/index.js";
import { canTransition, type MemberStatus } from "../membership/index.js";

/** The statuses staff may set by hand. (`invited`/`claimed` are written only by their own flows.) */
export const STAFF_SETTABLE_STATUSES = ["live", "lapsed", "removed"] as const;
export type StaffSettableStatus = (typeof STAFF_SETTABLE_STATUSES)[number];

export interface SetMemberStatusResult {
  memberId: string;
  from: MemberStatus;
  to: StaffSettableStatus;
}

export async function setMemberStatus(
  client: RoamClient,
  actor: AdminActor,
  args: { channelKey: string; memberId: string; status: StaffSettableStatus; note?: string | undefined },
): Promise<SetMemberStatusResult> {
  const channel = await getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${args.channelKey}'`);

  const { data: member, error: readErr } = await loose(client)
    .from("channel_members")
    .select("id, status, venue_id, source_name")
    .eq("id", args.memberId)
    .eq("channel_id", channel.id)
    .maybeSingle();
  if (readErr) throw new Error(`admin: member read failed: ${readErr.message}`);
  if (!member) throw new Error("admin: member not found in this channel");

  const from = member.status as MemberStatus;
  if (!canTransition(from, args.status)) {
    throw new Error(`admin: a member cannot move from '${from}' to '${args.status}'`);
  }
  if (args.status === "live" && !member.venue_id) {
    throw new Error("admin: a member must be matched to a venue before going live");
  }

  const patch: Record<string, unknown> = { status: args.status };
  if (args.status === "lapsed") patch.lapsed_at = new Date().toISOString();

  const { error: writeErr } = await loose(client)
    .from("channel_members")
    .update(patch)
    .eq("id", args.memberId)
    .eq("channel_id", channel.id)
    .eq("status", from); // optimistic: a concurrent change makes this a no-op rather than a wrong write
  if (writeErr) throw new Error(`admin: status write failed: ${writeErr.message}`);

  await recordAudit(client, actor, {
    action: "set_member_status",
    entityType: "channel_member",
    entityId: args.memberId,
    detail: { channel: args.channelKey, from, to: args.status, note: args.note ?? null },
  });

  return { memberId: args.memberId, from, to: args.status };
}
