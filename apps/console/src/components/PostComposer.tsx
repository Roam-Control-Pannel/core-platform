/**
 * PostComposer — Stage 3b. The multi-destination composer, opened from a
 * VenueOverviewCard's "Post an update" seam. Drives posts.create (protected,
 * owner-scoped RLS) for a venue the caller owns.
 *
 * Scope of this first cut (deliberately honest seams, not lying toggles):
 *   - kind: news | offer | event
 *   - destinations: 'profile' ALWAYS on (core requires it); 'feed' a real toggle.
 *     'follower_push' is a present-but-DISABLED seam — it arrives with the Push
 *     slice, which builds credit consumption + the send path. A toggle that set
 *     follower_push today would cost no credit and send nothing, so it stays off.
 *   - timing: publish-now only. Scheduling is a disabled seam — resolvePublishTiming
 *     supports it, but no publisher runs yet to flip a scheduled row live, so a
 *     scheduled post would be invisible. Honest seam until the publisher slice.
 *
 * Validation mirrors @roam/core/posts.validateComposition LOCALLY (core can't be
 * browser-bundled — the Node-ESM .js-suffix imports break Turbopack; same reason
 * VenueCard mirrors formatDistance). The server re-runs the real core validation in
 * posts.create, so this local copy is a UX nicety, never the source of truth.
 *
 * State ladder: idle form -> submitting -> created(success) | error(retry). The
 * caller refreshes nothing here; on success we report back so the card can show
 * a confirmation. Dates: posts.create returns only postId this slice.
 */
"use client";

import { useState } from "react";
import { Button, Card, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

type PostKind = "news" | "offer" | "event";

interface PostComposerProps {
  venueId: string;
  venueName: string;
  onClose: () => void;
  /** Fired after a successful publish so the caller can confirm / refresh. */
  onPublished: (postId: string) => void;
}

/** Local mirror of core's validateComposition rules (server re-validates). */
function localValidate(input: {
  kind: PostKind;
  title: string;
  body: string;
}): string | null {
  const hasContent = input.title.trim().length > 0 || input.body.trim().length > 0;
  if (!hasContent) return "Add a title or some text before publishing.";
  if (input.kind === "offer" && input.title.trim().length === 0) {
    return "An offer needs a title.";
  }
  return null;
}

type UiState = "idle" | "submitting" | "created" | "error";

export function PostComposer({ venueId, venueName, onClose, onPublished }: PostComposerProps) {
  const trpc = useTrpc();
  const [kind, setKind] = useState<PostKind>("news");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [toFeed, setToFeed] = useState(true);
  const [ui, setUi] = useState<UiState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    const localError = localValidate({ kind, title, body });
    if (localError) {
      setError(localError);
      return;
    }
    setUi("submitting");
    setError(null);

    const destinations: ("profile" | "feed" | "follower_push")[] = toFeed
      ? ["profile", "feed"]
      : ["profile"];

    try {
      const result = await trpc.posts.create.mutate({
        venueId,
        kind,
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        destinations,
        isDraft: false,
      });
      if (!result.created) {
        setError(result.validation.errors[0] ?? "Couldn't publish your post.");
        setUi("error");
        return;
      }
      setUi("created");
      onPublished(result.postId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't publish your post.");
      setUi("error");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(33,29,26,.38)",
        display: "grid",
        placeItems: "center",
        padding: "var(--space-4)",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <Card
        style={{ width: "100%", maxWidth: 560, padding: "var(--space-6)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--crimson-700)",
            marginBottom: 4,
          }}
        >
          Post an update
        </div>
        <h2
          className="t-h2"
          style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22, margin: "0 0 var(--space-2)" }}
        >
          {venueName}
        </h2>

        {ui === "created" ? (
          <CreatedState onClose={onClose} toFeed={toFeed} />
        ) : (
          <>
            <KindPicker kind={kind} onChange={setKind} />

            <Field label="Title" value={title} onChange={setTitle} placeholder="What's happening?" />
            <TextField label="Details" value={body} onChange={setBody} placeholder="Tell people more (optional for news)." />

            <DestinationRow toFeed={toFeed} onToggleFeed={() => setToFeed((f) => !f)} />

            {error ? (
              <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-3)" }} role="alert">
                {error}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-5)", justifyContent: "flex-end" }}>
              <Button variant="neutral" onClick={onClose} disabled={ui === "submitting"}>
                Cancel
              </Button>
              <Button variant="pri" onClick={() => void publish()} disabled={ui === "submitting"}>
                {ui === "submitting" ? "Publishing…" : "Publish now"}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function KindPicker({ kind, onChange }: { kind: PostKind; onChange: (k: PostKind) => void }) {
  const kinds: { value: PostKind; label: string }[] = [
    { value: "news", label: "News" },
    { value: "offer", label: "Offer" },
    { value: "event", label: "Event" },
  ];
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", margin: "var(--space-4) 0" }}>
      {kinds.map((k) => (
        <button key={k.value} onClick={() => onChange(k.value)} style={{ all: "unset", cursor: "pointer" }}>
          <Pill variant={kind === k.value ? "on" : "neutral"}>{k.label}</Pill>
        </button>
      ))}
    </div>
  );
}

function DestinationRow({ toFeed, onToggleFeed }: { toFeed: boolean; onToggleFeed: () => void }) {
  return (
    <div style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
      <SectionLabel>Where it goes</SectionLabel>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <Pill variant="ghost-crim">Your profile · always</Pill>
        <button onClick={onToggleFeed} style={{ all: "unset", cursor: "pointer" }}>
          <Pill variant={toFeed ? "on" : "neutral"}>Local feed{toFeed ? " · on" : ""}</Pill>
        </button>
        <span title="Reaching followers by push arrives with the Push slice">
          <Pill variant="neutral" style={{ opacity: 0.5 }}>Followers by push · soon</Pill>
        </span>
      </div>
    </div>
  );
}

function CreatedState({ onClose, toFeed }: { onClose: () => void; toFeed: boolean }) {
  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
        Published
      </div>
      <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
        Your update is live on your venue profile{toFeed ? " and in the local feed for people nearby" : ""}.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="pri" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: "grid", gap: 5, marginBottom: "var(--space-3)" }}>
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={200}
        style={inputStyle}
      />
    </label>
  );
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        maxLength={4000}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--ui)", lineHeight: 1.45 }}
      />
    </label>
  );
}

const inputStyle = {
  fontFamily: "var(--ui)",
  fontSize: 14,
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  background: "#fff",
  color: "var(--ink)",
  outline: "none",
} as const;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
      {children}
    </div>
  );
}
