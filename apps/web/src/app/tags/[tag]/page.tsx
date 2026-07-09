/**
 * Hashtag page — /tags/{tag}: everything on Roam carrying #tag. noindex: tag pages are
 * views over content that already has canonical indexable homes (topics, posts, walls) —
 * crawlers follow through, users land and browse. Next 15+/16 passes params as a Promise.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { TagFeed } from "../../../components/TagFeed";

const TAG_RE = /^[\p{L}\p{N}_]{2,50}$/u;

function cleanTag(raw: string): string | null {
  const tag = decodeURIComponent(raw).replace(/^#/, "").toLowerCase();
  return TAG_RE.test(tag) ? tag : null;
}

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }): Promise<Metadata> {
  const { tag } = await params;
  const clean = cleanTag(tag);
  return {
    title: clean ? `#${clean}` : "Hashtag",
    description: clean ? `Posts, discussion and updates tagged #${clean} on Roam.` : "Hashtags on Roam.",
    robots: { index: false, follow: true },
  };
}

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const clean = cleanTag(tag);
  if (!clean) {
    return (
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
        <p style={{ color: "var(--muted)" }}>That doesn&apos;t look like a hashtag.</p>
      </main>
    );
  }
  return <TagFeed tag={clean} />;
}
