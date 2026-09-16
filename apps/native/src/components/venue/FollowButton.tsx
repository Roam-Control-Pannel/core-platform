/**
 * FollowButton — follow/unfollow a venue, the native counterpart of web's FollowButton.
 *
 * This is the app's canonical GATED action: signed in it writes immediately; signed out it
 * raises the just-in-time sheet holding the follow, which then RESUMES on sign-in — the
 * same contract the pre-Home Discover screen established, now behind useAuthPrompt so it
 * works at any depth without the screen threading state.
 *
 * Optimistic, and reverting on failure: a follow that didn't persist is never left showing.
 * Both mutations are idempotent server-side, so a double-tap is harmless.
 */
import { useState } from "react";
import { Pressable, Text, StyleSheet } from "react-native";
import { color } from "@roam/design/tokens";
import { Icon, family } from "../../design";
import { useTrpc, useSession } from "../../lib/TrpcProvider";
import { useAuthPrompt } from "../AuthPrompt";
import { sh1 } from "../../design";

const NUDGE = "Sign in to follow this venue and get a heads-up when it posts.";

export interface FollowButtonProps {
  venueId: string;
  initialFollowing?: boolean;
}

export function FollowButton({ venueId, initialFollowing = false }: FollowButtonProps) {
  const trpc = useTrpc();
  const session = useSession();
  const prompt = useAuthPrompt();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    const before = following;
    setFollowing(!before);
    setBusy(true);
    try {
      if (before) await trpc.social.unfollowVenue.mutate({ venueId });
      else await trpc.social.followVenue.mutate({ venueId });
    } catch {
      setFollowing(before);
    } finally {
      setBusy(false);
    }
  }

  function onPress() {
    if (!session) {
      // Hold the intent — the follow lands the moment a live session exists.
      prompt(NUDGE, () => void toggle());
      return;
    }
    void toggle();
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: following }}
      accessibilityLabel={following ? "Unfollow venue" : "Follow venue"}
      hitSlop={6}
      style={({ pressed }) => [
        styles.btn,
        following ? styles.btnOn : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {following ? <Icon name="check" size={12} strokeWidth={2.5} color={color.card} /> : null}
      <Text style={[styles.label, following ? styles.labelOn : null]}>
        {following ? "Following" : "Follow"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line2,
    backgroundColor: color.card,
    ...sh1,
  },
  btnOn: { backgroundColor: color.crimson, borderColor: color.crimson },
  pressed: { opacity: 0.82 },
  label: { fontFamily: family.uiSemi, fontSize: 12.5, color: color.inkHi },
  labelOn: { color: color.card },
});
