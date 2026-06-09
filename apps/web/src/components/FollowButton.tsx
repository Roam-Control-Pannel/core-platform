/**
 * FollowButton — the consumer follow affordance for a venue. Mirrors the claim flow's
 * JIT-auth gate (see VenueDetail): signed in → toggle immediately; signed out → show
 * AuthPanel, and on sign-IN success resume the follow in the same sitting.
 *
 * Following a venue opts the user into its push notifications by default (the server's
 * follows.push_enabled defaults true); per-venue muting lives on the Following view,
 * not here. This button only toggles the follow EDGE.
 *
 * State is optimistic: the Pill flips on tap and the mutation runs underneath; on
 * failure we revert and surface the error. `initialFollowing` is supplied by the host
 * (VenueDetail passes it from a follow-state read; the grid passes it from a
 * page-level followingSet) so the button renders correct on first paint.
 *
 * Rendered as a Pill — the design system's intended home for follow buttons. Follow =
 * ghost-crim (crimson-tinted CTA); Following = on (ink-filled active chip).
 *
 * Unlike the claim flow, we do NOT port the email-confirmation resume (?claim=1 style):
 * follow is trivially repeatable and low-stakes, so sign-UP simply lands the user
 * signed-in-eventually and they tap Follow again. Sign-IN resumes in-sitting via onAuthed.
 */
"use client";

import { useCallback, useState } from "react";
import { Pill, Card } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";

export interface FollowButtonProps {
  venueId: string;
  /** Follow state known at render time (from the host's follow read). */
  initialFollowing: boolean;
  /** Where AuthPanel's email-confirmation link returns (sign-up path). */
  emailRedirectTo: string;
}

export function FollowButton({ venueId, initialFollowing, emailRedirectTo }: FollowButtonProps) {
  const trpc = useTrpc();
  const session = useSession();

  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run the follow/unfollow mutation, optimistically, reverting on failure. */
  const toggle = useCallback(async () => {
    const next = !following;
    setFollowing(next);
    setBusy(true);
    setError(null);
    try {
      if (next) {
        await trpc.social.followVenue.mutate({ venueId });
      } else {
        await trpc.social.unfollowVenue.mutate({ venueId });
      }
    } catch (e: unknown) {
      setFollowing(!next); // revert
      setError(e instanceof Error ? e.message : "Couldn't update follow.");
    } finally {
      setBusy(false);
    }
  }, [following, trpc, venueId]);

  /** Tap handler: signed in → toggle; signed out → show AuthPanel (JIT auth). */
  const onPressed = useCallback(() => {
    if (session) {
      void toggle();
    } else {
      setShowAuth(true);
    }
  }, [session, toggle]);

  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <Pill
        variant={following ? "on" : "ghost-crim"}
        size="sm"
        role="button"
        tabIndex={0}
        aria-pressed={following}
        aria-busy={busy}
        onClick={onPressed}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPressed();
          }
        }}
        style={{ cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
      >
        {following ? "Following" : "Follow"}
      </Pill>

      {error ? (
        <div style={{ fontSize: 11.5, color: "var(--crimson-700)" }}>{error}</div>
      ) : null}

      {showAuth ? (
        <Card style={{ padding: "var(--space-3)" }}>
          <AuthPanel
            emailRedirectTo={emailRedirectTo}
            intro="Sign in to follow this venue and get a heads-up when it posts."
            onAuthed={() => {
              setShowAuth(false);
              void toggle();
            }}
          />
        </Card>
      ) : null}
    </div>
  );
}
