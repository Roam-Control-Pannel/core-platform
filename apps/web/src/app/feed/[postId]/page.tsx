/**
 * Feed post-detail route — /feed/[postId]. The mobile post-detail screen; also the deep-link
 * target the web feed's "Share" produces. force-dynamic: live per-request data + runtime env.
 *
 * SEO: this server component resolves the published post once (anonymous, cached) for per-page
 * metadata (incl. the post image as the share card) and a SocialMediaPosting JSON-LD block in
 * the initial HTML. The interactive screen hydrates client-side.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { PostDetailScreen, type FeedPost } from "../../../components/PostDetail";
import { JsonLd } from "../../../components/JsonLd";
import { getPost } from "../../../lib/serverApi";
import { postMetadata, postJsonLd } from "../../../lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ postId: string }> }): Promise<Metadata> {
  const { postId } = await params;
  return postMetadata(await getPost(postId), postId);
}

export default async function FeedPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const post = await getPost(postId);
  // Seed the client screen so the post's text + image are in the initial HTML (the SSR body),
  // not just the metadata. The runtime shape matches FeedPost (posts.byId); the seo type is a
  // defensively-widened subset, so we narrow with the same cast the client uses for this query.
  const initialPost = (post as unknown as FeedPost | null) ?? null;
  return (
    <>
      {post ? <JsonLd data={postJsonLd(post, postId)} /> : null}
      <PostDetailScreen postId={postId} initialPost={initialPost} />
    </>
  );
}
