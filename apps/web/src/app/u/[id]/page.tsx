/**
 * Profile wall route — /u/[id]. A user's public wall: their posts, likes and comments. The
 * param is the profile (user) UUID; the component issues profiles.byId + profileWall.list.
 *
 * Public to view (browse-freely); posting is owner-only, liking/commenting need a session —
 * all prompted just-in-time, so the page does not gate. force-dynamic: live per-request data.
 *
 * SEO: this server component resolves the profile once (anonymous, cached) for per-page
 * metadata and a Person JSON-LD block in the initial HTML. The wall itself hydrates client-side.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { ProfileWall, type PublicProfile } from "../../../components/ProfileWall";
import { JsonLd } from "../../../components/JsonLd";
import { getProfile } from "../../../lib/serverApi";
import { profileMetadata, profileJsonLd } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return profileMetadata(await getProfile(id), id);
}

export default async function ProfileWallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getProfile(id);
  // Seed the header (name, @handle, bio, avatar) into the initial HTML; the wall's posts still
  // hydrate client-side. The seo + component profile shapes match (profiles.byId).
  const initialProfile = (profile as unknown as PublicProfile | null) ?? null;
  return (
    <>
      {profile ? <JsonLd data={profileJsonLd(profile, id)} /> : null}
      <ProfileWall userId={id} initialProfile={initialProfile} />
    </>
  );
}
