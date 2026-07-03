/**
 * Wall-post permalink route — /p/[postId]. The shareable home of one personal profile-wall post:
 * the deep-link target the wall's "Share" produces, with OG tags (incl. the post's first image)
 * so it unfurls as a card on WhatsApp / LinkedIn / Facebook. force-dynamic: live per-request
 * data + runtime env.
 *
 * SEO: this server component resolves the post once (anonymous, cached) for per-page metadata
 * and a SocialMediaPosting JSON-LD block in the initial HTML. The interactive screen hydrates
 * client-side. Not sitemap'd — personal content is linkable, not crawl-promoted.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { WallPostScreen } from "../../../components/WallPostScreen";
import type { WallPost } from "../../../components/ProfileWall";
import { JsonLd } from "../../../components/JsonLd";
import { getWallPost } from "../../../lib/serverApi";
import { wallPostMetadata, wallPostJsonLd } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ postId: string }> }): Promise<Metadata> {
  const { postId } = await params;
  return wallPostMetadata(await getWallPost(postId), postId);
}

export default async function WallPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const post = await getWallPost(postId);
  // Seed the client screen so the post's text + image are in the initial HTML. The runtime shape
  // matches WallPost (profileWall.byId); the seo type is a subset, so we narrow with a cast.
  const initialPost = (post as unknown as WallPost | null) ?? null;
  return (
    <>
      {post ? <JsonLd data={wallPostJsonLd(post, postId)} /> : null}
      <WallPostScreen postId={postId} initialPost={initialPost} />
    </>
  );
}
