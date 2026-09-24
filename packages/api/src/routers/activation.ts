/**
 * activation router — /activate (F2G plan 2.4). The member path, replacing invite→claim.
 *
 * THE SHAPE. Four calls, each of which can only ever narrow what the caller can do:
 *   candidates — which roster rows this signed-in account may attempt, given the venues it owns or
 *                the invite it followed. Returns no e-mail addresses.
 *   start      — either "your account e-mail already matches" or "a code is on its way to i•••@…".
 *   verify     — check a typed code. Burns an attempt on a miss.
 *   activate   — confer, once possession has been proved in THIS request.
 *
 * WHY POSSESSION IS RE-PROVED ON `activate` RATHER THAN REMEMBERED. There is no session flag saying
 * "this account verified a code ten minutes ago". `activate` re-checks the same two facts `start`
 * did — the account's e-mail matches, or a code for this exact triple was consumed recently — so a
 * caller cannot verify against one roster row and then activate a different one. The proof is
 * scoped to the (member, venue, account) triple, never to the session.
 *
 * WHAT NEVER LEAVES. The roster's e-mail address. Not in `candidates`, not in `start`, not in an
 * error. A caller learns only a mask, and only after asking about a row they could already see.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { channels, activation as rules, matching } from "@roam/core";
import { router, protectedProcedure, escalateToService } from "../trpc.js";
import * as activation from "../f2g/activation.js";
import { channelSender } from "../f2g/activationEmail.js";
import { verifyInviteToken } from "../f2g/inviteToken.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };

const triple = z.object({
  memberId: z.string().uuid(),
  venueId: z.string().uuid(),
});

/** Resolve the channel the request is on, refusing the default (which has no roster). */
async function requireChannel(ctx: any, channelKey: string) {
  const channel = await channels.getChannelByKey(ctx.db, channelKey);
  if (!channel || channel.isDefault) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Unknown organisation." });
  }
  return channel;
}

/**
 * Has this account proved control of the roster address for this exact triple? Either its own
 * verified e-mail is the roster's, or it consumed a code for this triple inside the TTL window.
 *
 * The consumed-code window is the code's own TTL rather than something longer: the proof should not
 * outlive the credential that produced it by much, and a user who dawdles past it simply asks for
 * another code.
 */
async function hasProof(
  service: any,
  args: { memberId: string; venueId: string; profileId: string; accountEmail: string | null; rosterEmail: string | null },
): Promise<boolean> {
  if (rules.emailMatchesRoster(args.accountEmail, args.rosterEmail)) return true;
  const since = new Date(Date.now() - rules.ACTIVATION_CODE_TTL_MS).toISOString();
  const { data, error } = await (service as Loose)
    .from("channel_activation_codes")
    .select("id")
    .eq("member_id", args.memberId)
    .eq("venue_id", args.venueId)
    .eq("profile_id", args.profileId)
    .not("consumed_at", "is", null)
    .gte("consumed_at", since)
    .limit(1);
  if (error) throw new Error(`activation: proof read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export const activationRouter = router({
  /**
   * The rows this account may attempt. Two sources, both of which the caller already controls:
   *   * venues they OWN — the ordinary "I've claimed my venue, now link my membership" case;
   *   * an invite token, which since 2.4 names a (member, venue) pair but confers nothing.
   * Anything else is invisible: this is not a roster search.
   */
  candidates: protectedProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32), token: z.string().max(400).optional() }))
    .query(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx, input.channelKey);
      const { data: me } = await ctx.db.auth.getUser();
      const uid = me.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to activate." });

      const service = escalateToService(ctx.env);
      const out: { memberId: string; venueId: string; business: string; venueName: string; bound: boolean }[] = [];

      // Venues this account owns, and the roster rows bound to them.
      const { data: owned } = await (ctx.db as unknown as Loose)
        .from("venues")
        .select("id, name")
        .eq("owner_id", uid)
        .eq("status", "claimed");
      const ownedIds = ((owned ?? []) as { id: string; name: string }[]).map((v) => v.id);

      if (ownedIds.length > 0) {
        const { data: rows } = await (service as Loose)
          .from("channel_members")
          .select("id, source_name, venue_id, status")
          .eq("channel_id", channel.id)
          .in("venue_id", ownedIds)
          .in("status", ["imported", "invited"]);
        for (const r of (rows ?? []) as any[]) {
          const venue = ((owned ?? []) as any[]).find((v) => v.id === r.venue_id);
          out.push({
            memberId: r.id, venueId: r.venue_id,
            business: r.source_name ?? "", venueName: venue?.name ?? "", bound: true,
          });
        }
      }

      // An invite token names one pair. It proves nothing — it only saves the member from hunting
      // for their own row — so the row is still subject to every check below.
      if (input.token && ctx.env.f2g.inviteSecret) {
        const payload = verifyInviteToken(input.token, ctx.env.f2g.inviteSecret);
        if (payload) {
          const member = await activation.readMember(service, {
            channelId: channel.id, memberId: payload.memberId,
          });
          if (member && (member.status === "imported" || member.status === "invited")) {
            const already = out.some((c) => c.memberId === member.id);
            if (!already) {
              const { data: v } = await (service as Loose)
                .from("venues").select("name").eq("id", payload.venueId).maybeSingle();
              out.push({
                memberId: member.id, venueId: payload.venueId,
                business: member.sourceName, venueName: (v?.name as string) ?? "",
                bound: member.venueId === payload.venueId,
              });
            }
          }
        }
      }

      return { channelName: channel.name, candidates: out };
    }),

  /** Begin: either the account already matches, or a code goes out. */
  start: protectedProcedure
    .input(triple.extend({ channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx, input.channelKey);
      const { data: me } = await ctx.db.auth.getUser();
      const uid = me.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to activate." });

      const service = escalateToService(ctx.env);
      const result = await activation.issueActivationCode(
        service,
        {
          brevoApiKey: ctx.env.brevo.apiKey,
          sender: channelSender(
            { email: ctx.env.brevo.senderEmail, name: ctx.env.brevo.senderName },
            channel,
          ),
          channelName: channel.orgName ?? channel.name,
        },
        {
          channelId: channel.id,
          memberId: input.memberId,
          venueId: input.venueId,
          profileId: uid,
          accountEmail: me.user?.email ?? null,
        },
      );
      return result;
    }),

  /** Check a typed code. A miss burns one of the five attempts on that code. */
  verify: protectedProcedure
    .input(triple.extend({ channelKey: z.string().min(1).max(32), code: z.string().min(1).max(16) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx, input.channelKey);
      const { data: me } = await ctx.db.auth.getUser();
      const uid = me.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to activate." });

      return activation.verifyActivationCode(escalateToService(ctx.env), {
        channelId: channel.id,
        memberId: input.memberId,
        venueId: input.venueId,
        profileId: uid,
        code: input.code,
      });
    }),

  /**
   * Confer. Re-proves possession, binds an unbound row when the postcodes agree fully, then calls
   * the 0161 definer — which refuses an unbound pair regardless, so a failed bind cannot be talked
   * past here.
   */
  activate: protectedProcedure
    .input(triple.extend({ channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx, input.channelKey);
      const { data: me } = await ctx.db.auth.getUser();
      const uid = me.user?.id;
      if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to activate." });

      const service = escalateToService(ctx.env);
      const member = await activation.readMember(service, {
        channelId: channel.id, memberId: input.memberId,
      });
      // Same answer for "no such row" as for "not yours": a probe learns nothing.
      if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "That activation is not available." });

      const proved = await hasProof(service, {
        memberId: member.id, venueId: input.venueId, profileId: uid,
        accountEmail: me.user?.email ?? null, rosterEmail: member.sourceEmail,
      });
      if (!proved) {
        await activation.recordAttempt(service, {
          channelId: channel.id, memberId: member.id, venueId: input.venueId,
          profileId: uid, outcome: "activate_no_proof",
        });
        throw new TRPCError({ code: "FORBIDDEN", message: "Confirm the code sent to your organisation's email first." });
      }

      // Bind an unbound row, if and only if the postcodes agree in full.
      if (!member.venueId) {
        const { data: v } = await (service as Loose)
          .from("venues").select("address").eq("id", input.venueId).maybeSingle();
        const bind = await activation.bindMemberVenue(service, {
          channelId: channel.id, memberId: member.id, venueId: input.venueId, profileId: uid,
          rosterPostcode: member.sourcePostcode,
          venuePostcode: matching.extractPostcode((v?.address as string) ?? null),
        });
        if (bind !== "bound") {
          // "review" is not a failure of the user's — it is the Association's queue. Say so.
          return { outcome: bind === "review" ? ("review" as const) : ("conflict" as const), venueId: null };
        }
      }

      const result = await activation.activateMemberVenue(service, {
        memberId: member.id, venueId: input.venueId, claimantId: uid,
      });
      await activation.recordAttempt(service, {
        channelId: channel.id, memberId: member.id, venueId: input.venueId,
        profileId: uid, outcome: `activate_${result.outcome}`,
      });
      return result;
    }),
});
/* eslint-enable @typescript-eslint/no-explicit-any */
