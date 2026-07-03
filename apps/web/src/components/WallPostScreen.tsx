/**
 * WallPostScreen — the /p/[postId] permalink for a single profile-wall post: the shareable,
 * externally-linkable home of one personal post (the OG tags on the route make it unfurl as a
 * card on WhatsApp / LinkedIn / Facebook). Renders the same PostCard as the wall itself, with a
 * back link to the author's profile. Ships loading / not-found / error states; the server passes
 * an SSR seed so the shared link paints instantly.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PostCard, type WallPost } from "./ProfileWall";

export function WallPostScreen({ postId, initialPost }: { postId: string; initialPost?: WallPost | null }) {
  const trpc = useTrpc();
  const session = useSession();
  const myId = session?.user?.id ?? null;
  const [post, setPost] = useState<WallPost | null | undefined>(initialPost);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const byId = trpc.profileWall.byId as unknown as {
      query: (i: { postId: string }) => Promise<WallPost | null>;
    };
    return byId.query({ postId });
  }, [trpc, postId]);

  useEffect(() => {
    let cancelled = false;
    // When the server seeded the post (SSR), refresh silently — pick up the viewer's like state
    // without blanking the already-rendered content. Only the unseeded path shows the skeleton.
    const seeded = initialPost !== undefined;
    if (!seeded) {
      setPost(undefined);
      setError(null);
    }
    load()
      .then((p) => {
        if (!cancelled) setPost(p);
      })
      .catch((e: unknown) => {
        if (!cancelled && !seeded) setError(e instanceof Error ? e.message : "Couldn't load this post.");
      });
    return () => {
      cancelled = true;
    };
  }, [load, initialPost]);

  const onChanged = useCallback(() => {
    void load().then((p) => setPost(p)).catch(() => {});
  }, [load]);

  const authorPath = post ? `/u/${post.author.handle ?? post.author.id ?? ""}` : "/";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href={authorPath}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span>
        {post?.author.displayName ?? (post?.author.handle ? `@${post.author.handle}` : "Profile")}
      </Link>

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : post === undefined ? (
        <div style={{ height: 180, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : post === null ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            Post not found
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>It may have been removed, or the link is wrong.</p>
        </Card>
      ) : (
        <PostCard post={post} canInteract={!!session} isOwner={myId === post.authorId} myId={myId} onChanged={onChanged} />
      )}
    </main>
  );
}
