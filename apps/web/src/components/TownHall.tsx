/**
 * TownHall — the per-locality public forum board (/town-hall).
 *
 * Local discussion, scoped to the place you're browsing: locals start TOPICS and upvote the
 * ones they want surfaced. PUBLIC to read (browse any town's board signed-out, the same
 * browse-freely contract as Explore); starting a topic or upvoting needs an account, prompted
 * just-in-time (the claim-flow pattern).
 *
 * The active place comes from useCurrentPlace (shared with Explore, persisted per-device) and
 * the PlaceSwitcher re-roots the board. The API derives the locality slug from the place name,
 * so switching towns here shows that town's board and posting lands a topic on it.
 *
 * Ships every state (States matrix): a content-shaped skeleton while loading, an honest
 * first-run empty state ("be the first…"), an error state, and the loaded list.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, Seg } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { TopicUpvote } from "./TopicUpvote";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";

interface TopicListItem {
  id: string;
  title: string;
  body: string;
  upvoteCount: number;
  replyCount: number;
  lastActivityAt: string;
  createdAt: string;
  author: TownHallAuthor;
  viewerUpvoted: boolean;
}

type Sort = "recent" | "popular";

export function TownHall() {
  const trpc = useTrpc();
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();

  const [topics, setTopics] = useState<TopicListItem[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recent");
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    setTopics(undefined);
    setError(null);
    const listTopics = trpc.townHall.listTopics as unknown as {
      query: (input: { localityName: string; sort: Sort }) => Promise<{ topics: TopicListItem[] }>;
    };
    try {
      const res = await listTopics.query({ localityName: place.name, sort });
      return res.topics ?? [];
    } catch (e: unknown) {
      throw e instanceof Error ? e : new Error("Couldn't load the Town Hall.");
    }
  }, [trpc, place.name, sort]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((t) => {
        if (!cancelled) setTopics(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the Town Hall.");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onPosted = useCallback(() => {
    setComposing(false);
    void load().then((t) => setTopics(t)).catch(() => {});
  }, [load]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/explore"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: "var(--muted)",
          textDecoration: "none",
          marginBottom: "var(--space-4)",
        }}
      >
        <span aria-hidden>←</span> Explore
      </Link>

      <header style={{ marginBottom: "var(--space-4)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0 }}>
          Town Hall
        </h1>
        <p style={{ marginTop: 4, marginBottom: "var(--space-4)", color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>
          What locals are talking about. Start a topic, share a tip, or upvote what matters where you are.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <PlaceSwitcher value={place} onChange={setPlace} />
          <Seg
            options={[
              { value: "recent", label: "Recent" },
              { value: "popular", label: "Popular" },
            ]}
            value={sort}
            onChange={(v) => setSort(v)}
          />
        </div>
      </header>

      {/* Start a topic — auth-gated, prompted just-in-time. */}
      {composing ? (
        session ? (
          <TopicComposer localityName={place.name} onPosted={onPosted} onCancel={() => setComposing(false)} />
        ) : (
          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <AuthPanel
              intro={`Sign in to start a topic in ${place.name}.`}
              emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
              onAuthed={() => {
                /* session change re-renders; the composer shows next */
              }}
            />
          </Card>
        )
      ) : (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="pri" onClick={() => setComposing(true)}>
            ＋ Start a topic
          </Button>
        </div>
      )}

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : topics === undefined ? (
        <TopicListSkeleton />
      ) : topics.length === 0 ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            No topics in {place.name} yet
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
            Be the first to start a conversation — ask a question, share a recommendation, or suggest something.
          </p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {topics.map((t) => (
            <TopicRow key={t.id} topic={t} canVote={!!session} />
          ))}
        </div>
      )}
    </main>
  );
}

function TopicRow({ topic, canVote }: { topic: TopicListItem; canVote: boolean }) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
        <TopicUpvote
          topicId={topic.id}
          initialUpvoted={topic.viewerUpvoted}
          initialCount={topic.upvoteCount}
          canVote={canVote}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Link href={`/town-hall/${topic.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, lineHeight: 1.3 }}>
              {topic.title}
            </div>
          </Link>
          <p
            style={{
              margin: "4px 0 0",
              color: "var(--ink-2)",
              fontSize: 13.5,
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {topic.body}
          </p>
          <div style={{ marginTop: "var(--space-2)", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
            <span>{townHallAuthor(topic.author)}</span>
            <span aria-hidden>·</span>
            <span>{timeAgo(topic.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>{topic.replyCount === 1 ? "1 reply" : `${topic.replyCount} replies`}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function TopicComposer({
  localityName,
  onPosted,
  onCancel,
}: {
  localityName: string;
  onPosted: () => void;
  onCancel: () => void;
}) {
  const trpc = useTrpc();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const createTopic = trpc.townHall.createTopic as unknown as {
      mutate: (input: { localityName: string; title: string; body: string }) => Promise<{ id: string }>;
    };
    try {
      await createTopic.mutate({ localityName, title, body });
      onPosted();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Couldn't post your topic.");
      setBusy(false);
    }
  }, [trpc, localityName, title, body, onPosted]);

  const canPost = title.trim().length > 0 && body.trim().length > 0 && !busy;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
        New topic in {localityName}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title — e.g. Best Sunday roast around here?"
        aria-label="Topic title"
        maxLength={140}
        style={inputStyle}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Share the detail…"
        aria-label="Topic detail"
        rows={4}
        style={{ ...inputStyle, resize: "vertical", minHeight: 96 }}
      />
      {err ? (
        <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>
          {err}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void submit()} disabled={!canPost}>
          {busy ? "Posting…" : "Post topic"}
        </Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginBottom: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16, // ≥16px so iOS Safari doesn't zoom on focus
  color: "var(--ink)",
  outline: "none",
};

function TopicListSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 92, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ))}
    </div>
  );
}
