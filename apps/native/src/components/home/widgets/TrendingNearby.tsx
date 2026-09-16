/**
 * TrendingNearby — the best-reviewed venues around the current place, ported from web's
 * TrendingNearby widget.
 *
 * "Trending" is the same definition web uses: rating desc, review volume breaking ties,
 * over the nearest 12 venues (venues.near, a public read). Rows are ranked 1..5 with a
 * mono index, an initial avatar, the venue's type, and its ★ rating.
 *
 * Its action leads to Explore — the native counterpart of web's /explore.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { color, space } from "@roam/design/tokens";
import { family } from "../../../design";
import { useTrpc } from "../../../lib/TrpcProvider";
import { initial } from "../../../lib/format";
import type { Place } from "../../../lib/useCurrentPlace";
import { Section } from "../Section";
import { common } from "../common";

interface NearRow {
  id: string;
  name: string;
  category: string | null;
  rating: number | null;
  ratingCount: number | null;
  primaryTypeLabel: string | null;
}

export function TrendingNearby({ place }: { place: Place }) {
  const trpc = useTrpc();
  const router = useRouter();
  const q = useQuery({
    queryKey: ["venues.near", place.lat, place.lng, 12],
    queryFn: () => trpc.venues.near.query({ lat: place.lat, lng: place.lng, limit: 12 }),
  });

  const venues = ((q.data ?? []) as NearRow[])
    .slice()
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0))
    .slice(0, 5);

  return (
    <Section
      title="Trending nearby"
      icon="sparkle"
      action={{ label: "Explore", onPress: () => router.push("/explore") }}
    >
      {q.isError ? (
        <Text style={common.mutedNote}>Couldn&rsquo;t load venues near you just now.</Text>
      ) : q.isPending ? (
        <View style={styles.skeletons}>
          <View style={common.rowSkeleton} />
          <View style={common.rowSkeleton} />
          <View style={common.rowSkeleton} />
        </View>
      ) : venues.length === 0 ? (
        <Text style={common.mutedNote}>No venues found near {place.name} yet.</Text>
      ) : (
        <View>
          {venues.map((v, i) => (
            <Pressable
              key={v.id}
              onPress={() => router.push("/explore")}
              style={({ pressed }) => [common.row, pressed ? common.rowPressed : null]}
            >
              <Text style={styles.rank}>{i + 1}</Text>
              <View style={[common.avatar, styles.avatar]}>
                <Text style={[common.avatarText, styles.avatarText]}>{initial(v.name)}</Text>
              </View>
              <View style={styles.main}>
                <Text style={styles.name} numberOfLines={1}>
                  {v.name}
                </Text>
                <Text style={styles.category} numberOfLines={1}>
                  {v.primaryTypeLabel ?? v.category ?? "Venue"}
                </Text>
              </View>
              {v.rating != null ? (
                <View style={styles.rate}>
                  {/* Gold is reserved for the Gold tier and ★ ratings — this is the latter. */}
                  <Text style={styles.star}>★</Text>
                  <Text style={styles.rating}>{v.rating.toFixed(1)}</Text>
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  skeletons: { gap: space[2] },
  rank: {
    width: 14,
    fontFamily: family.monoBold,
    fontSize: 12,
    color: color.muted,
    textAlign: "center",
  },
  avatar: { width: 32, height: 32 },
  avatarText: { fontSize: 13.5 },
  main: { flex: 1, gap: 1 },
  name: { fontFamily: family.uiSemi, fontSize: 13.5, color: color.ink },
  category: { fontFamily: family.ui, fontSize: 11.5, color: color.muted },
  rate: { flexDirection: "row", alignItems: "center", gap: 3 },
  star: { color: color.gold, fontSize: 12.5 },
  rating: { fontFamily: family.uiSemi, fontSize: 12.5, color: color.inkHi },
});
