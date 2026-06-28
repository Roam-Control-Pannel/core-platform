/**
 * Feed post-detail route — /feed/[postId]. The mobile post-detail screen; also the deep-link
 * target the web feed's "Share" produces. force-dynamic: live per-request data + runtime env.
 *
 * Next 15+/16 passes route params as a Promise — we await it before use.
 */
export const dynamic = "force-dynamic";

import { PostDetailScreen } from "../../../components/PostDetail";

export default async function FeedPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  return <PostDetailScreen postId={postId} />;
}
