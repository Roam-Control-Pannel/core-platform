/**
 * Invite route — /i/[handle]. A personal invite landing (growth loop #1): someone shares this link
 * and a prospective member lands on a warm page that NAMES the inviter, then signs up. The inviter
 * is stashed client-side (InviteLanding) and applied once a session exists (InviteApply, in the
 * layout) — which records referral attribution and connects the two.
 *
 * Public (browse-freely); the sign-up happens inline via AuthPanel. SSR resolves the inviter once
 * (anonymous, cached) for the branded share card + to seed the greeting into the initial HTML.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getProfileByHandle } from "../../../lib/serverApi";
import { inviteMetadata } from "../../../lib/seo";
import { InviteLanding } from "../../../components/InviteLanding";

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  return inviteMetadata(await getProfileByHandle(handle), handle);
}

export default async function InvitePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const profile = await getProfileByHandle(handle);
  return (
    <InviteLanding
      handle={handle}
      inviterName={
        profile
          ? (profile.displayName && profile.displayName.trim()) || (profile.handle ? `@${profile.handle}` : null)
          : null
      }
      avatarUrl={profile?.avatarUrl ?? null}
      known={!!profile}
    />
  );
}
