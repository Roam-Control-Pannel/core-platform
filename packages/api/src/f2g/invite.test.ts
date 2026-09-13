import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { claimMemberVenue, sendMemberInvite, renderInviteEmail } from "./invite.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MEMBER = "11111111-1111-1111-1111-111111111111";
const VENUE = "22222222-2222-2222-2222-222222222222";
const CLAIMANT = "33333333-3333-3333-3333-333333333333";

/** A tiny rpc-only client for claimMemberVenue: it returns whatever the test seeds. */
function rpcClient(resp: { data: any; error: { message: string } | null }): RoamClient {
  return { rpc: async () => resp } as unknown as RoamClient;
}

describe("claimMemberVenue — definer outcome mapping", () => {
  it("maps a successful conferral row to { outcome: 'claimed' }", async () => {
    const c = rpcClient({ data: { outcome: "claimed", venue_id: VENUE, claimed: true }, error: null });
    expect(await claimMemberVenue(c, { memberId: MEMBER, venueId: VENUE, claimantId: CLAIMANT })).toEqual({
      outcome: "claimed",
      venueId: VENUE,
    });
  });

  it("maps an idempotent re-click (already_claimed) through unchanged", async () => {
    const c = rpcClient({ data: { outcome: "already_claimed", venue_id: VENUE }, error: null });
    expect((await claimMemberVenue(c, { memberId: MEMBER, venueId: VENUE, claimantId: CLAIMANT })).outcome).toBe(
      "already_claimed",
    );
  });

  it("accepts a one-element array result shape from PostgREST", async () => {
    const c = rpcClient({ data: [{ outcome: "claimed", venue_id: VENUE }], error: null });
    expect((await claimMemberVenue(c, { memberId: MEMBER, venueId: VENUE, claimantId: CLAIMANT })).outcome).toBe(
      "claimed",
    );
  });

  it.each([
    ["VENUE_MISMATCH", "venue_mismatch"],
    ["CLAIMED_BY_OTHER", "claimed_by_other"],
    ["NOT_CLAIMABLE", "not_claimable"],
    ["MEMBER_NOT_FOUND", "not_found"],
    ["VENUE_NOT_FOUND", "not_found"],
    ["CLAIMANT_REQUIRED", "not_found"],
  ])("maps the definer raise %s to outcome '%s'", async (raise, outcome) => {
    const c = rpcClient({ data: null, error: { message: raise } });
    expect((await claimMemberVenue(c, { memberId: MEMBER, venueId: VENUE, claimantId: CLAIMANT })).outcome).toBe(
      outcome,
    );
  });

  it("throws on a genuinely unexpected DB error", async () => {
    const c = rpcClient({ data: null, error: { message: "deadlock detected" } });
    await expect(claimMemberVenue(c, { memberId: MEMBER, venueId: VENUE, claimantId: CLAIMANT })).rejects.toThrow(
      /deadlock/,
    );
  });
});

// ── sendMemberInvite guard branches (no Brevo/network reached) ────────────────────────────────────

const CHANNEL_ROW = { id: "ch-f2g", key: "f2g", name: "Food to Go", is_default: false, active: true };

/** Chainable stand-in: `channels` → the channel row, `channel_members` → the seeded member row. */
function guardClient(opts: { channel?: any; member?: any }): RoamClient {
  const client: any = {
    from(table: string) {
      const resp =
        table === "channels"
          ? { data: opts.channel ?? null, error: null }
          : table === "channel_members"
            ? { data: opts.member ?? null, error: null }
            : { data: null, error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        range: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve(resp),
      };
      return chain;
    },
  };
  return client as unknown as RoamClient;
}

const CONFIGURED = {
  inviteSecret: "s",
  inviteTtlMs: 1000,
  brevoApiKey: "k",
  sender: { email: "no-reply@roam-local.com", name: "Roam" },
  webOrigin: "https://foodtogo.example",
};

describe("sendMemberInvite — guard branches", () => {
  it("is 'unconfigured' when the invite secret is missing", async () => {
    const r = await sendMemberInvite(guardClient({}), { ...CONFIGURED, inviteSecret: null }, { channelKey: "f2g", memberId: MEMBER });
    expect(r).toEqual({ outcome: "unconfigured", invited: false });
  });

  it("is 'unconfigured' when the Brevo key is missing", async () => {
    const r = await sendMemberInvite(guardClient({}), { ...CONFIGURED, brevoApiKey: null }, { channelKey: "f2g", memberId: MEMBER });
    expect(r.outcome).toBe("unconfigured");
  });

  it("is 'not_found' for an unknown channel", async () => {
    const r = await sendMemberInvite(guardClient({ channel: null }), CONFIGURED, { channelKey: "nope", memberId: MEMBER });
    expect(r.outcome).toBe("not_found");
  });

  it("is 'not_found' when the member isn't on the channel", async () => {
    const r = await sendMemberInvite(guardClient({ channel: CHANNEL_ROW, member: null }), CONFIGURED, { channelKey: "f2g", memberId: MEMBER });
    expect(r.outcome).toBe("not_found");
  });

  it("is 'not_matched' when the member has no matched venue", async () => {
    const member = { id: MEMBER, channel_id: "ch-f2g", source_name: "Cafe", source_email: "o@c.example", venue_id: null, status: "imported" };
    const r = await sendMemberInvite(guardClient({ channel: CHANNEL_ROW, member }), CONFIGURED, { channelKey: "f2g", memberId: MEMBER });
    expect(r.outcome).toBe("not_matched");
  });

  it("is 'no_email' when the member has no source_email", async () => {
    const member = { id: MEMBER, channel_id: "ch-f2g", source_name: "Cafe", source_email: null, venue_id: VENUE, status: "imported" };
    const r = await sendMemberInvite(guardClient({ channel: CHANNEL_ROW, member }), CONFIGURED, { channelKey: "f2g", memberId: MEMBER });
    expect(r.outcome).toBe("no_email");
  });

  it("is 'not_invitable' when the member is already claimed", async () => {
    const member = { id: MEMBER, channel_id: "ch-f2g", source_name: "Cafe", source_email: "o@c.example", venue_id: VENUE, status: "claimed" };
    const r = await sendMemberInvite(guardClient({ channel: CHANNEL_ROW, member }), CONFIGURED, { channelKey: "f2g", memberId: MEMBER });
    expect(r.outcome).toBe("not_invitable");
  });
});

describe("renderInviteEmail", () => {
  it("includes the claim URL and channel name, and escapes the source name", async () => {
    const { subject, html, text } = renderInviteEmail({
      sourceName: "Bob & Sons <Cafe>",
      claimUrl: "https://foodtogo.example/f2g/claim?token=abc",
      channelName: "Food to Go",
    });
    expect(subject).toContain("Food to Go");
    expect(html).toContain("https://foodtogo.example/f2g/claim?token=abc");
    expect(html).toContain("Bob &amp; Sons &lt;Cafe&gt;"); // escaped, no raw < & >
    expect(html).not.toContain("Bob & Sons <Cafe>");
    expect(text).toContain("https://foodtogo.example/f2g/claim?token=abc");
  });

  it("falls back to a friendly greeting when the source name is blank", async () => {
    const { text } = renderInviteEmail({ sourceName: "   ", claimUrl: "https://x/y", channelName: "Food to Go" });
    expect(text).toContain("Hi there,");
  });
});
