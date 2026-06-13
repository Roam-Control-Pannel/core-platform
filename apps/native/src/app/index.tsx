import { useCallback, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { formatDistance } from "@roam/core/geo";
import { color } from "@roam/design/tokens";
import { useTrpc, useSession } from "../lib/TrpcProvider";
import { AuthSheet } from "../components/AuthSheet";
import { useDeviceOrigin } from "../lib/useDeviceOrigin";
import { getSupabaseNative } from "../lib/supabase";

// Native Discover. Fetches venues.near (publicProcedure — public browsing works with no
// session) from a fixed Darlington origin and renders the near->far list. Claimed venues
// carry a Follow control: the first GATED action on native. Signed in -> social.followVenue
// runs immediately; signed out -> the AuthSheet rises (just-in-time auth) and the follow
// RESUMES on sign-in. The query origin comes from useDeviceOrigin (real device fix,
// with a Darlington fallback when location is denied/unavailable).

interface VenueRow {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  distanceM: number;
}

export default function DiscoverScreen() {
  const trpc = useTrpc();
  const session = useSession();
  const deviceOrigin = useDeviceOrigin();

  // Follow state: venue_ids the caller has followed THIS session (optimistic). We don't
  // pre-load myFollows here (the list is the minimal surface) — a tapped follow flips the
  // row; server-truth seeds on a later detail-screen slice. Set, so re-render is cheap.
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  // JIT auth: the venue the user tried to follow while signed out, held so the follow
  // resumes after sign-in. null = sheet closed.
  const [pendingFollowVenueId, setPendingFollowVenueId] = useState<string | null>(null);

  // Don't fetch until the origin resolves (real or fallback) — otherwise we'd query
  // once on a placeholder then re-query on the real fix. Key on the resolved coords so
  // a real fix re-roots the list cleanly.
  const origin = deviceOrigin.origin;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["venues.near", origin],
    queryFn: () => trpc.venues.near.query({ ...origin!, limit: 50 }),
    enabled: origin !== null,
  });

  // Run the follow mutation and flip the row optimistically. Assumes a session exists
  // (caller gates on it). social.followVenue is idempotent server-side, so a re-follow
  // is harmless.
  const doFollow = useCallback(
    async (venueId: string) => {
      setFollowed((prev) => new Set(prev).add(venueId));
      try {
        await trpc.social.followVenue.mutate({ venueId });
      } catch {
        // Revert on failure — never show a follow that didn't persist.
        setFollowed((prev) => {
          const next = new Set(prev);
          next.delete(venueId);
          return next;
        });
      }
    },
    [trpc],
  );

  // Tap handler: signed in -> follow now; signed out -> open the sheet, holding the intent.
  const onFollowPressed = useCallback(
    (venueId: string) => {
      if (session) {
        void doFollow(venueId);
      } else {
        setPendingFollowVenueId(venueId);
      }
    },
    [session, doFollow],
  );

  // Sign out via the Supabase singleton. onAuthStateChange in TrpcProvider clears the
  // session (reverting the follow gate) — we don't touch session state here. We DO clear
  // the optimistic followed set: those pills belong to the signed-out user's session, not
  // the screen's permanent truth. Confirm first so an accidental tap can't drop the session.
  const onSignOutPressed = useCallback(() => {
    Alert.alert(
      "Sign out?",
      "You'll need to sign in again to follow venues.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void getSupabaseNative().auth.signOut();
            setFollowed(new Set());
          },
        },
      ],
    );
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View style={styles.headerMain}>
          <Text style={styles.brand}>Roam</Text>
          <Text style={styles.subtitle}>
            Discover · {deviceOrigin.status === "ready" ? "near you" : "near Darlington"}
          </Text>
        </View>
        {session && (
          <Pressable onPress={onSignOutPressed} style={styles.signOutBtn} hitSlop={8}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        )}
      </View>

      {deviceOrigin.status === "resolving" && (
        <View style={styles.centerFill}>
          <ActivityIndicator />
          <Text style={styles.muted}>Finding your location…</Text>
        </View>
      )}

      {deviceOrigin.status !== "resolving" && isLoading && (
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
          data={data as VenueRow[]}
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
              {item.claimed && (
                <Pressable
                  onPress={() => onFollowPressed(item.id)}
                  style={[styles.followBtn, followed.has(item.id) && styles.followBtnOn]}
                >
                  <Text
                    style={[
                      styles.followBtnText,
                      followed.has(item.id) && styles.followBtnTextOn,
                    ]}
                  >
                    {followed.has(item.id) ? "Following" : "Follow"}
                  </Text>
                </Pressable>
              )}
            </View>
          )}
        />
      )}

      <AuthSheet
        visible={pendingFollowVenueId !== null}
        intro="Sign in to follow this venue and get a heads-up when it posts."
        onClose={() => setPendingFollowVenueId(null)}
        onAuthed={() => {
          const venueId = pendingFollowVenueId;
          setPendingFollowVenueId(null);
          // Session now lands via onAuthStateChange (provider rebuilds the client); resume
          // the held follow. doFollow reads the live trpc client at call time.
          if (venueId) void doFollow(venueId);
        }}
      />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerMain: { gap: 2 },
  signOutBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.2)",
    marginTop: 4,
  },
  signOutText: { fontSize: 13, color: "#4D463F", fontWeight: "600" },
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
  followBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: color.crimsonTint,
  },
  followBtnOn: { backgroundColor: color.crimson },
  followBtnText: { fontSize: 12.5, fontWeight: "600", color: color.crimson700 },
  followBtnTextOn: { color: "#fff" },
});
