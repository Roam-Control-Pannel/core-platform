/**
 * PostLike — the like control on a feed post card, the native counterpart of web's
 * PostLikeButton.
 *
 * Optimistic: the heart fills and the count moves the instant it's tapped, then reconciles
 * to the server's authoritative count (both toggle procedures return it) — and reverts if
 * the write fails, so a like that didn't persist is never left showing. Signed out, the tap
 * raises the just-in-time sheet holding the like itself, so it lands after sign-in.
 *
 * The feed mixes two kinds of post that live in different tables, so `source` picks the
 * matching procedure: business posts toggle via posts.toggleLike, people's wall posts via
 * profileWall.toggleLike. Both take { postId } and return { liked, likeCount }, so only the
 * call site differs.
 */
import { useState } from "react";
import { Pressable, Text, StyleSheet } from "react-native";
import { color } from "@roam/design/tokens";
import { Icon, family } from "../../design";
import { useTrpc, useSession } from "../../lib/TrpcProvider";
import { useAuthPrompt } from "../AuthPrompt";

const NUDGE = "Sign in to like posts from people and businesses near you.";

/** Which feed the post came from — selects the toggle procedure. */
export type LikeSource = "venue" | "wall";

export interface PostLikeProps {
  postId: string;
  initialLiked: boolean;
  initialCount: number;
  source?: LikeSource;
}

export function PostLike({ postId, initialLiked, initialCount, source = "venue" }: PostLikeProps) {
  const trpc = useTrpc();
  const session = useSession();
  const prompt = useAuthPrompt();
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    // Optimistic flip first — the tap must feel instant.
    const before = { liked, count };
    setLiked(!liked);
    setCount(Math.max(0, count + (liked ? -1 : 1)));
    setBusy(true);
    try {
      const res =
        source === "wall"
          ? await trpc.profileWall.toggleLike.mutate({ postId })
          : await trpc.posts.toggleLike.mutate({ postId });
      setLiked(res.liked);
      setCount(res.likeCount);
    } catch {
      setLiked(before.liked);
      setCount(before.count);
    } finally {
      setBusy(false);
    }
  }

  function onPress() {
    if (!session) {
      prompt(NUDGE, () => void toggle());
      return;
    }
    void toggle();
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={liked ? "Unlike post" : "Like post"}
      hitSlop={6}
      style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
    >
      <Icon name="heart" size={15} color={liked ? color.crimson : color.muted} />
      <Text style={[styles.label, liked ? styles.labelOn : null]}>{count > 0 ? count : "Like"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: { flexDirection: "row", alignItems: "center", gap: 6 },
  pressed: { opacity: 0.6 },
  label: { fontFamily: family.uiSemi, fontSize: 13, color: color.muted },
  labelOn: { color: color.crimson700 },
});
