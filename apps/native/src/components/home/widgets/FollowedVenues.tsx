/**
 * FollowedVenues — the businesses you follow plus the loyalty deals only followers see,
 * ported from web's FollowedVenues widget.
 *
 * This is the section that earns the follow: following a business is what unlocks its
 * exclusive offers, so the empty state says exactly that and points at Discover. Both
 * reads are protected (social.myFollows, offers.forFollowed); the deals read is allowed to
 * fail on its own — you still see who you follow.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { color, space } from "@roam/design/tokens";
import { Button, Pill, family } from "../../../design";
import { useTrpc, useSession } from "../../../lib/TrpcProvider";
import { initial, timeAgo } from "../../../lib/format";
import { Section } from "../Section";
import { SignInNudge } from "../SignInNudge";
import { common } from "../common";

const NUDGE =
  "Follow a business to unlock its exclusive loyalty deals — they'll appear here, just for followers.";

interface FollowRow {
  venue_id: string;
  venues: { id: string; name: string; category: string | null } | null;
}

interface Deal {
  id: string;
  venueName: string | null;
  title: string;
  details: string | null;
  endsAt: string | null;
}

export function FollowedVenues() {
  const trpc = useTrpc();
  const session = useSession();
  const router = useRouter();
  const signedIn = !!session;

  const follows = useQuery({
    queryKey: ["social.myFollows"],
    queryFn: () => trpc.social.myFollows.query(),
    enabled: signedIn,
  });

  const deals = useQuery({
    queryKey: ["offers.forFollowed"],
    queryFn: () => trpc.offers.forFollowed.query(),
    enabled: signedIn,
  });

  const rows = (follows.data?.ok ? (follows.data.follows ?? []) : []) as FollowRow[];
  const offers = (deals.data ?? []) as Deal[];

  return (
    <Section title="Followed venues" icon="heart">
      {!signedIn ? (
        <SignInNudge note={NUDGE} />
      ) : follows.isError ? (
        <Text style={common.mutedNote}>Couldn&rsquo;t load your followed venues just now.</Text>
      ) : follows.isPending ? (
        <View style={styles.skeletons}>
          <View style={common.rowSkeleton} />
          <View style={common.rowSkeleton} />
        </View>
      ) : rows.length === 0 ? (
        <View>
          <Text style={common.mutedNote}>
            You&rsquo;re not following any businesses yet. Follow one to get its exclusive loyalty
            deals here.
          </Text>
          <View style={styles.cta}>
            <Button variant="neutral" size="sm" onPress={() => router.push("/explore")}>
              Find businesses to follow
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.body}>
          {/* Who you follow — chips with an initial avatar. */}
          <View style={styles.chips}>
            {rows.map((f) => {
              const name = f.venues?.name ?? "Venue";
              return (
                <Pressable
                  key={f.venue_id}
                  onPress={() => router.push("/explore")}
                  style={({ pressed }) => [common.venueChip, pressed ? styles.chipPressed : null]}
                >
                  <View style={[common.avatar, styles.chipAvatar]}>
                    <Text style={[common.avatarText, styles.chipAvatarText]}>{initial(name)}</Text>
                  </View>
                  <Text style={styles.chipLabel} numberOfLines={1}>
                    {name}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Their follower-only deals. */}
          <View>
            <Text style={common.eyebrow}>Exclusive deals for you</Text>
            {offers.length > 0 ? (
              <View style={styles.deals}>
                {offers.map((d) => (
                  <View key={d.id} style={common.outlineCard}>
                    <View style={styles.dealMain}>
                      <Text style={styles.dealTitle} numberOfLines={2}>
                        {d.title}
                      </Text>
                      <Text style={styles.dealMeta} numberOfLines={1}>
                        {[d.venueName, d.endsAt ? `ends ${timeAgo(d.endsAt)}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <Pill variant="ghost-crim" size="sm">
                      Offer
                    </Pill>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={[common.mutedNote, styles.noDeals]}>
                No live deals from your venues right now — we&rsquo;ll show them here the moment one
                posts a loyalty offer.
              </Text>
            )}
          </View>
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  skeletons: { gap: space[2] },
  cta: { marginTop: space[3], alignItems: "flex-start" },
  body: { gap: space[4] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[2] },
  chipPressed: { backgroundColor: color.crimsonTint },
  chipAvatar: { width: 22, height: 22 },
  chipAvatarText: { fontSize: 11 },
  chipLabel: { fontFamily: family.uiSemi, fontSize: 13, color: color.ink, maxWidth: 160 },
  deals: { gap: space[2], marginTop: space[2] },
  dealMain: { flex: 1, gap: 2 },
  dealTitle: { fontFamily: family.uiSemi, fontSize: 13.5, color: color.ink },
  dealMeta: { fontFamily: family.ui, fontSize: 11.5, color: color.muted },
  noDeals: { marginTop: space[2] },
});
