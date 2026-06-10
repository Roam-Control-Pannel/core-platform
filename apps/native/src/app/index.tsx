import { useMemo } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { formatDistance } from "@roam/core/geo";
import { makeTrpcClient } from "../lib/trpc";

// CHUNK 3: the first native data screen. Fetches venues.near (publicProcedure,
// no auth — public browsing) from a fixed Darlington origin and renders the
// near->far list. distanceM comes server-side from PostGIS; formatDistance from
// @roam/core/geo renders it (reusing chunk 2's helper). Real geolocation
// (expo-location) is a later slice — the origin is labelled honestly.
const DARLINGTON = { lat: 54.5253, lng: -1.5849 };

export default function DiscoverScreen() {
  // No auth yet: getAccessToken returns null (public browsing is valid).
  const trpc = useMemo(() => makeTrpcClient(() => null), []);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["venues.near", DARLINGTON],
    queryFn: () => trpc.venues.near.query({ ...DARLINGTON, limit: 50 }),
  });

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.brand}>Roam</Text>
        <Text style={styles.subtitle}>Discover · near Darlington</Text>
      </View>

      {isLoading && (
        <View style={styles.centerFill}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading venues…</Text>
        </View>
      )}

      {isError && (
        <View style={styles.centerFill}>
          <Text style={styles.errorTitle}>Couldn’t load venues</Text>
          <Text style={styles.muted}>{(error as Error).message}</Text>
        </View>
      )}

      {data && (
        <FlatList
          data={data}
          keyExtractor={(v) => v.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.centerFill}>
              <Text style={styles.muted}>No venues nearby yet.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.name}>{item.name}</Text>
                {item.category && <Text style={styles.muted}>{item.category}</Text>}
              </View>
              <Text style={styles.distance}>{formatDistance(item.distanceM)}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 2 },
  brand: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 13, opacity: 0.6 },
  centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  list: { paddingHorizontal: 20, paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.1)",
    gap: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: "600" },
  distance: { fontSize: 14, opacity: 0.7, fontVariant: ["tabular-nums"] },
  muted: { fontSize: 13, opacity: 0.6 },
  errorTitle: { fontSize: 16, fontWeight: "600" },
});
