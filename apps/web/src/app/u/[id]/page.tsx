/**
 * Profile route — /u/[id]. The segment is now the user's @handle (the canonical, username URL);
 * a legacy UUID is still accepted and 301-redirected to the handle, so every old link keeps
 * working and search engines consolidate on one canonical address.
 *
 * Public to view (browse-freely); posting is owner-only, liking/commenting need a session —
 * all prompted just-in-time, so the page does not gate. force-dynamic: live per-request data.
 *
 * SEO: this server component resolves the profile once (anonymous, cached) for per-page metadata
 * and a Person JSON-LD block, and seeds the header into the initial HTML. The wall hydrates.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { ProfileWall, type PublicProfile } from "../../../components/ProfileWall";
import { JsonLd } from "../../../components/JsonLd";
import { getProfile, getProfileByHandle } from "../../../lib/serverApi";
import { profileMetadata, profileJsonLd, type ProfileSeo } from "../../../lib/seo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the route param (handle or legacy UUID) to a profile. */
async function resolve(idOrHandle: string): Promise<ProfileSeo | null> {
  return UUID_RE.test(idOrHandle) ? getProfile(idOrHandle) : getProfileByHandle(idOrHandle);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return profileMetadata(await resolve(id), id);
}

export default async function ProfileWallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Legacy UUID link → 301 to the canonical /u/{handle} when the user has one.
  if (UUID_RE.test(id)) {
    const byId = await getProfile(id);
    if (byId?.handle) permanentRedirect(`/u/${byId.handle}`);
    // No handle yet (pre-backfill) — render in place, keyed by the UUID.
    const seed = (byId as unknown as PublicProfile | null) ?? null;
    return (
      <>
        {byId ? <JsonLd data={profileJsonLd(byId, id)} /> : null}
        <ProfileWall userId={id} initialProfile={seed} />
      </>
    );
  }

  const profile = await getProfileByHandle(id);
  // ProfileWall fetches by user id; hand it the resolved UUID (or the raw param when unknown, so
  // it renders its own not-found state).
  const userId = profile?.id ?? id;
  const seed = (profile as unknown as PublicProfile | null) ?? null;
  return (
    <>
      {profile ? <JsonLd data={profileJsonLd(profile, id)} /> : null}
      <ProfileWall userId={userId} initialProfile={seed} />
    </>
  );
}
