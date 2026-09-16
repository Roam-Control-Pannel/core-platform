/**
 * HomeScreen — the native Home hub, the counterpart of web's Home (apps/web/src/components/Home.tsx).
 *
 * Web lays Home out as a WALL: a main feed column beside a right RAIL of widgets, collapsing
 * to a single column (feed first, rail below) under 1000px. A phone is always below that
 * breakpoint, so native IS the collapsed layout — header, composer, the local feed, then the
 * widget stack. Same sections, same order as web's widget registry, same copy.
 *
 * Everything here follows web's two structural rules:
 *
 *   PUBLIC TO VIEW. Browsing needs no account. The sections that can't fill without one
 *   (chats, plans, followed venues) show a sign-in nudge; they never gate the page.
 *
 *   INDEPENDENT SECTIONS. Each owns its query and its own loading/empty/error state, so a
 *   slow or failed section never blocks the rest of the hub.
 *
 * Not in this slice, and deliberately absent rather than stubbed:
 *   - the Customise sheet + widget reordering (web persists a per-user layout) and the
 *     Basecamp rail footer that leads to the full widget set;
 *   - the place switcher — the place is detected rather than chosen (see useCurrentPlace);
 *   - the ephemeral header strips (ActiveFriends presence, BirthdayTreats);
 *   - the widgets with no native reads yet: affiliate deals, transit, saved stops, saved deals.
 *
 * Sections whose web action links at a screen that doesn't exist on native yet simply show
 * no action; the affordance appears with the route, not before it.
 */
import { useCallback, useState } from "react";
import { ScrollView, View, RefreshControl, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { color, space } from "@roam/design/tokens";
import { useTrpc, useSession } from "../../lib/TrpcProvider";
import { useCurrentPlace } from "../../lib/useCurrentPlace";
import { HomeHeader } from "./HomeHeader";
import { Composer } from "./Composer";
import { HomeFeed } from "./HomeFeed";
import { TownForum } from "./widgets/TownForum";
import { TrendingNearby } from "./widgets/TrendingNearby";
import { RecentChats } from "./widgets/RecentChats";
import { UpcomingPlans } from "./widgets/UpcomingPlans";
import { FollowedVenues } from "./widgets/FollowedVenues";
import { MarketSeam } from "./widgets/MarketSeam";

export function HomeScreen() {
  const trpc = useTrpc();
  const session = useSession();
  const queryClient = useQueryClient();
  const current = useCurrentPlace();
  const [refreshing, setRefreshing] = useState(false);

  // The greeting's first name — the profile's display name, first word. A failure here just
  // leaves the greeting impersonal, so it has no error state of its own.
  const userId = session?.user?.id ?? null;
  const profile = useQuery({
    queryKey: ["profiles.byId", userId],
    queryFn: () => trpc.profiles.byId.query({ userId: userId! }),
    enabled: userId !== null,
  });
  const firstName =
    (profile.data?.displayName ?? "").trim().split(/\s+/)[0]?.trim() || null;

  /**
   * Pull to refresh — refetch every section at once. Invalidating the whole cache (rather
   * than naming keys) keeps this correct as sections are added: a new widget's query is
   * refreshed by the gesture the day it lands, with no change here.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries();
    } finally {
      setRefreshing(false);
    }
  }, [queryClient]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={color.crimson}
            colors={[color.crimson]}
          />
        }
      >
        <HomeHeader current={current} firstName={firstName} />

        <View style={styles.column}>
          <Composer
            placeName={current.place.name}
            firstName={firstName}
            // A wall post lands in the feed's social half, so that's what has to refetch.
            onPosted={() =>
              void queryClient.invalidateQueries({ queryKey: ["profileWall.friendsFeed"] })
            }
          />

          <HomeFeed place={current.place} />

          {/* The widget stack, in web's registry order. */}
          <TownForum place={current.place} />
          <TrendingNearby place={current.place} />
          <RecentChats />
          <UpcomingPlans />
          <FollowedVenues />
          <MarketSeam place={current.place} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.paper },
  content: {
    paddingHorizontal: space[4],
    paddingTop: space[4],
    // Deep bottom padding so the last card clears the home indicator / nav bar.
    paddingBottom: space[16],
  },
  column: { gap: space[5] },
});
