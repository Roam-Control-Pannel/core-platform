/**
 * Composer — the "What's on your mind?" prompt at the top of the wall, ported from
 * HomeComposer in web's Home.tsx.
 *
 * Collapsed it's an avatar plus a slim pill and a row of quick-start chips; tapping the
 * pill or a chip expands an inline composer that posts to YOUR wall via profileWall.create
 * — which is the same wall the feed's "For you" tab reads, so a new post appears in the
 * column right below it. The chips exist because "finish this sentence" beats "fill a blank
 * box" — each seeds the body with a concrete opening line, which is the biggest lever on
 * first-post rate for someone new to their area.
 *
 * Signed out, tapping anything raises the just-in-time sheet with the composer's own
 * intent held, so the sitting continues once the session lands.
 *
 * Scope note: web's expanded state is the full WallComposer (photo picker, media upload,
 * location). This slice ports the TEXT path only, so the photo affordances web shows are
 * deliberately absent rather than present-and-dead; media is its own slice.
 */
import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { color, space } from "@roam/design/tokens";
import { Card, Button, Icon, family, type IconName } from "../../design";
import { useTrpc, useSession } from "../../lib/TrpcProvider";
import { useAuthPrompt } from "../AuthPrompt";

/** Quick-start chips — icon, label, and the line each seeds into the body. */
const STARTERS: { id: string; icon: IconName; label: string; seed: (place: string) => string }[] = [
  { id: "gem", icon: "sparkle", label: "Local gem", seed: () => "A local gem worth knowing about: " },
  { id: "hello", icon: "wave", label: "Say hello", seed: (p) => `New to Roam in ${p} — hello! ` },
  { id: "food", icon: "dining", label: "Good food", seed: () => "A great place to eat around here: " },
  { id: "tip", icon: "idea", label: "Local tip", seed: () => "One thing every local should know: " },
];

const NUDGE = "Sign in to post to your wall — your neighbours will see it on their feed.";

export interface ComposerProps {
  placeName: string;
  /** First name, so the prompt can address the author by name as web's does. */
  firstName: string | null;
  /** Called after a successful post, so the feed can pick it up. */
  onPosted?: () => void;
}

export function Composer({ placeName, firstName, onPosted }: ComposerProps) {
  const trpc = useTrpc();
  const session = useSession();
  const prompt = useAuthPrompt();

  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);

  /** Expand with an optional seed line. Signed out, raise the sheet and resume on success. */
  function expand(seed: string) {
    if (!session) {
      prompt(NUDGE, () => {
        setPosted(false);
        setBody(seed);
        setOpen(true);
      });
      return;
    }
    setPosted(false);
    setError(null);
    setBody(seed);
    setOpen(true);
  }

  async function post() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await trpc.profileWall.create.mutate({ body: text });
      setBody("");
      setOpen(false);
      setPosted(true);
      onPosted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't post that. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    return (
      <Card style={styles.card}>
        <View style={styles.expandedHeader}>
          <Text style={styles.expandedTitle}>Create post</Text>
          <Pressable
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
            style={styles.close}
          >
            <Icon name="close" size={15} color={color.ink2} />
          </Pressable>
        </View>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="What's on your mind?"
          placeholderTextColor={color.faint}
          multiline
          autoFocus
          style={styles.input}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.postRow}>
          {busy ? <ActivityIndicator color={color.crimson} /> : null}
          <Button variant="pri" size="sm" onPress={post} disabled={busy || body.trim().length === 0}>
            Post
          </Button>
        </View>
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.promptRow}>
        <View style={styles.avatar}>
          <Icon name="person" size={19} color={color.crimson700} />
        </View>
        <Pressable onPress={() => expand("")} style={styles.promptPill}>
          <Text style={styles.promptText} numberOfLines={1}>
            {firstName ? `What's on your mind, ${firstName}?` : "What's on your mind?"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.chips}>
        {STARTERS.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => expand(s.seed(placeName))}
            style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
          >
            <Icon name={s.icon} size={14} color={color.crimson700} />
            <Text style={styles.chipLabel}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      {posted ? (
        <View style={styles.postedRow}>
          <Icon name="check" size={14} color={color.success} />
          <Text style={styles.postedText}>Posted to your wall.</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: space[4], paddingVertical: space[3] },
  promptRow: { flexDirection: "row", alignItems: "center", gap: space[3] },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: color.crimsonTint,
    alignItems: "center",
    justifyContent: "center",
  },
  promptPill: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: color.paper2,
    borderWidth: 1,
    borderColor: color.line,
  },
  promptText: { fontFamily: family.ui, fontSize: 15.5, color: color.muted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[2], marginTop: space[3] },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: color.paper2,
    borderWidth: 1,
    borderColor: color.line,
  },
  chipPressed: { backgroundColor: color.crimsonTint },
  chipLabel: { fontFamily: family.uiSemi, fontSize: 13, color: color.ink2 },
  postedRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: space[2] },
  postedText: { fontFamily: family.ui, fontSize: 13, color: color.ink2 },
  expandedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: space[2],
  },
  expandedTitle: { fontFamily: family.display, fontSize: 15, color: color.ink },
  close: {
    width: 30,
    height: 30,
    borderRadius: 999,
    backgroundColor: color.paper2,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    fontFamily: family.ui,
    fontSize: 15.5,
    lineHeight: 22,
    color: color.ink,
    minHeight: 96,
    textAlignVertical: "top",
    paddingVertical: space[2],
  },
  error: { fontFamily: family.ui, fontSize: 13, color: color.crimson700, marginBottom: space[2] },
  postRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space[3] },
});
