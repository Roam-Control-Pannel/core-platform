/**
 * RecentChats — your three most recent conversations, ported from web's RecentChats widget.
 *
 * Auth-gated: signed out it shows the sign-in nudge rather than gating the page (the
 * browse-freely rule). Each row carries the chat-kind glyph — plan chats get the crimson
 * tint, group and direct chats the neutral one — the kind, its participant count, and how
 * long ago it moved.
 */
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { color, space } from "@roam/design/tokens";
import { Icon, family, type IconName } from "../../../design";
import { useTrpc, useSession } from "../../../lib/TrpcProvider";
import { plural, timeAgo } from "../../../lib/format";
import { Section } from "../Section";
import { SignInNudge } from "../SignInNudge";
import { common } from "../common";

const NUDGE = "Sign in to see your conversations and plans with people nearby.";

type ChatKind = "plan" | "group" | "direct";

interface ChatRow {
  id: string;
  kind: ChatKind;
  title: string | null;
  name: string | null;
  updatedAt: string;
  participantCount: number;
}

/** Chat-kind glyph + label; only plan chats take the crimson tint, as on web. */
const CHAT_KIND: Record<ChatKind, { glyph: IconName; label: string; crim: boolean }> = {
  plan: { glyph: "plan", label: "Plan chat", crim: true },
  group: { glyph: "users", label: "Group", crim: false },
  direct: { glyph: "chat", label: "Direct", crim: false },
};

export function RecentChats() {
  const trpc = useTrpc();
  const session = useSession();
  const signedIn = !!session;

  const q = useQuery({
    queryKey: ["chat.listThreads"],
    queryFn: () => trpc.chat.listThreads.query(),
    enabled: signedIn,
  });

  const rows = ((q.data ?? []) as ChatRow[]).slice(0, 3);

  return (
    <Section title="Recent chats" icon="chat">
      {!signedIn ? (
        <SignInNudge note={NUDGE} />
      ) : q.isError ? (
        <Text style={common.mutedNote}>Couldn&rsquo;t load your chats just now.</Text>
      ) : q.isPending ? (
        <View style={styles.skeletons}>
          <View style={common.rowSkeleton} />
          <View style={common.rowSkeleton} />
        </View>
      ) : rows.length === 0 ? (
        <Text style={common.mutedNote}>
          No chats yet. Message a friend or open a plan to start one — it&rsquo;ll show up here.
        </Text>
      ) : (
        <View>
          {rows.map((row) => {
            const meta = CHAT_KIND[row.kind] ?? CHAT_KIND.group;
            const name = row.name?.trim() || row.title?.trim() || meta.label;
            const sub =
              row.kind === "direct"
                ? meta.label
                : `${meta.label} · ${plural(row.participantCount, "person", "people")}`;
            return (
              <View key={row.id} style={common.row}>
                <View style={[styles.glyph, meta.crim ? styles.glyphCrim : styles.glyphNeutral]}>
                  <Icon
                    name={meta.glyph}
                    size={13}
                    color={meta.crim ? color.crimson700 : color.ink2}
                  />
                </View>
                <View style={styles.main}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {sub}
                  </Text>
                </View>
                <Text style={styles.when}>{timeAgo(row.updatedAt)}</Text>
              </View>
            );
          })}
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  skeletons: { gap: space[2] },
  glyph: {
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: color.line,
  },
  glyphCrim: { backgroundColor: color.crimsonTint },
  glyphNeutral: { backgroundColor: color.paper2 },
  main: { flex: 1, gap: 1 },
  name: { fontFamily: family.uiSemi, fontSize: 13.5, color: color.ink },
  sub: { fontFamily: family.ui, fontSize: 11.5, color: color.muted },
  when: { fontFamily: family.ui, fontSize: 12, color: color.muted },
});
