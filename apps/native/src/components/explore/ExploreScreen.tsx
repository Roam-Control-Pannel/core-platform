/**
 * ExploreScreen — the place-anchored discovery surface, ported from web's Explore.
 *
 * TWO LOAD PATHS, deliberately distinct — the same split web makes:
 *   - DEFAULT / "All": venues.near from the place centre, all categories, near→far.
 *   - CATEGORY VIEW: a pill tap reads venues.inCategoryNear — claimed venues first, then
 *     near→far within the tapped group.
 * Both live in one query keyed on (category, place), so rapid pill switching can't commit a
 * stale result: react-query renders the key you're on. That replaces web's manual
 * generation-counter guard, which exists because it drives the loads with raw effects.
 *
 * SUB-CATEGORY STRIP: in a category view, a horizontally-scrolling row of the leaf Places
 * types present in the loaded set (each venue carries its matched types in `categories`).
 * Tapping one filters CLIENT-SIDE — no new fetch, the data is already here.
 *
 * SEARCH: instant client-side filter over the loaded set by name. When that has no match for
 * a typed name (≥3 chars) it falls through, debounced, to search.global — so a venue that
 * exists in Roam but isn't in this place's loaded set can still be found. Those rows are a
 * reduced shape (no cover, no claim state), which is why they render as unclaimed cards
 * without a distance.
 *
 * Loading uses a content-shaped skeleton, not a spinner, per the States spec; empty reads
 * "new" rather than "broken". A FlatList (not a ScrollView) carries the grid — it's a real
 * list of up to 50 image cards — with the search/pills as its header.
 *
 * Not ported, and absent rather than stubbed:
 *   - DEMAND-DRIVEN SUPPLY. Web's category tap and sparse-area load first POST /api/ingest
 *     and /api/ingest-area to pull fresh venues from Google Places. Those are Next route
 *     handlers holding a server-side secret, not tRPC procedures, so native cannot call
 *     them. Explore here reads whatever supply already exists; a category in a cold area
 *     will look emptier on native than on web until someone opens it on the web app.
 *   - The map + "open in Maps" hand-off (no map on native yet), the NI transit widgets, the
 *     Food to Go "Order ahead" badge, the anonymous discovery meter (a localStorage growth
 *     mechanic), the place switcher, and web's Browse/Feed segment — the local feed is
 *     Home's, already built.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { color, space } from "@roam/design/tokens";
import { Card, Pill, Icon, family, text, type IconName } from "../../design";
import { useTrpc, useSession } from "../../lib/TrpcProvider";
import { useCurrentPlace } from "../../lib/useCurrentPlace";
import { CATEGORY_GROUPS, categoryIcon, categoryLabel, leafLabel } from "../../lib/categories";
import { VenueCard, type VenueCardData } from "../venue/VenueCard";

/** Venues revealed per page; "Load more" reveals the next batch of this many. */
const PAGE_SIZE = 15;

/** Map a near / inCategoryNear row to the card shape. */
function toCardData(v: {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
  ratingCount?: number | null;
  priceLevel?: string | null;
  primaryTypeLabel?: string | null;
  businessStatus?: string | null;
  distanceM?: number | null;
  categories?: string[] | null;
  coverPhotoId?: string | null;
}): VenueCardData {
  return {
    id: v.id,
    name: v.name,
    claimed: v.claimed,
    category: v.category,
    rating: v.rating,
    ratingCount: v.ratingCount ?? null,
    priceLevel: v.priceLevel ?? null,
    primaryTypeLabel: v.primaryTypeLabel ?? null,
    businessStatus: v.businessStatus ?? null,
    distanceM: v.distanceM ?? null,
    categories: v.categories ?? null,
    coverPhotoId: v.coverPhotoId ?? null,
  };
}

export function ExploreScreen() {
  const trpc = useTrpc();
  const session = useSession();
  const { place } = useCurrentPlace();

  // null = the "All" view (venues.near). A group name = a category view.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // The selected leaf type within a category view, or null for "all sub-categories".
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // One query for both load paths. The key carries the category, so switching pills is a
  // cache read (or a fresh fetch) with no chance of an earlier load committing late.
  const venuesQuery = useQuery({
    queryKey: ["explore.venues", activeCategory, place.lat, place.lng],
    queryFn: async (): Promise<VenueCardData[]> => {
      if (activeCategory === null) {
        const rows = await trpc.venues.near.query({ lat: place.lat, lng: place.lng, limit: 50 });
        return rows.map(toCardData);
      }
      const res = await trpc.venues.inCategoryNear.query({
        category: activeCategory,
        lat: place.lat,
        lng: place.lng,
        // Load a deep set; the list pages through it client-side in PAGE_SIZE steps.
        pageSize: 50,
        pageOffset: 0,
      });
      return res.venues.map(toCardData);
    },
  });

  const venues = venuesQuery.data;

  // The caller's follow set — one read for the whole list, so N cards don't each fetch.
  // Shares its key (and therefore its cache) with Home's followed-venues section.
  const follows = useQuery({
    queryKey: ["social.myFollows"],
    queryFn: () => trpc.social.myFollows.query(),
    enabled: !!session,
  });
  const followingSet = useMemo(() => {
    const rows = follows.data?.ok ? (follows.data.follows ?? []) : [];
    return new Set(rows.map((f) => f.venue_id));
  }, [follows.data]);

  // Sub-category options: the distinct leaf types across the loaded set, in first-seen
  // order. Only meaningful in a category view — the All view's refinement is the group
  // pills themselves.
  const subCategories = useMemo(() => {
    if (!venues || activeCategory === null) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const v of venues) {
      for (const leaf of v.categories ?? []) {
        if (!seen.has(leaf)) {
          seen.add(leaf);
          ordered.push(leaf);
        }
      }
    }
    return ordered;
  }, [venues, activeCategory]);

  // Instant client-side matches over the already-loaded set.
  const localMatches = useMemo(() => {
    if (!venues) return [];
    const q = query.trim().toLowerCase();
    let list = activeSub === null ? venues : venues.filter((v) => (v.categories ?? []).includes(activeSub));
    if (q) list = list.filter((v) => v.name.toLowerCase().includes(q));
    return list;
  }, [venues, activeSub, query]);

  // Debounce the typed name so the fall-through search doesn't fire per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 500);
    return () => clearTimeout(timer);
  }, [query]);

  // Server name search — only when the loaded set has NO match, so a venue already on
  // screen never triggers a call.
  const needsServerSearch = debouncedQuery.length >= 3 && localMatches.length === 0;
  const searchQuery = useQuery({
    queryKey: ["search.global", debouncedQuery, place.lat, place.lng],
    queryFn: () =>
      trpc.search.global.query({ q: debouncedQuery, lat: place.lat, lng: place.lng, limitPer: 12 }),
    enabled: needsServerSearch,
  });

  // search.global returns a reduced venue shape — no claim state, cover or price — so these
  // render as unclaimed cards. Never invent the missing fields.
  const searchResults = useMemo<VenueCardData[]>(() => {
    if (!needsServerSearch) return [];
    return (searchQuery.data?.venues ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      claimed: false,
      category: v.category,
      rating: v.rating,
      distanceM: v.distanceM,
    }));
  }, [needsServerSearch, searchQuery.data]);

  const shown = localMatches.length > 0 ? localMatches : searchResults;

  // Back to page 1 whenever the underlying set changes.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [venues, activeSub, query]);

  const visible = useMemo(() => shown.slice(0, visibleCount), [shown, visibleCount]);

  // Resolve the VISIBLE page's covers in one batch, so each card paints its real photo
  // instead of doing its own round-trip. Only ids we haven't asked for yet (tracked in a
  // ref, so growing the page never re-fetches) — the same cost discipline web applies,
  // since each resolution can bill Google. A failure just leaves those cards on the tile.
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const requestedCoverIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const wanted = visible.filter(
      (v) => v.coverPhotoId && !requestedCoverIds.current.has(v.coverPhotoId),
    );
    if (wanted.length === 0) return;
    const photoIds = Array.from(new Set(wanted.map((v) => v.coverPhotoId as string)));
    photoIds.forEach((id) => requestedCoverIds.current.add(id));
    let cancelled = false;
    trpc.venues.photoMediaUrls
      .query({ photoIds })
      .then((r) => {
        if (cancelled || !r?.urls) return;
        setCoverUrls((prev) => {
          const next = { ...prev };
          for (const v of wanted) {
            const url = v.coverPhotoId ? r.urls[v.coverPhotoId] : undefined;
            if (url) next[v.id] = url;
          }
          return next;
        });
      })
      .catch(() => {
        /* leave these cards on the fallback tile */
      });
    return () => {
      cancelled = true;
    };
  }, [visible, trpc]);

  const onPickCategory = useCallback((group: string | null) => {
    setActiveCategory(group);
    setActiveSub(null);
  }, []);

  const searching = needsServerSearch && searchQuery.isPending;

  const header = (
    <View>
      <Text style={styles.title}>Explore {place.name}</Text>
      <View style={styles.placeLine}>
        <Icon name="place" size={13} color={color.crimson700} />
        <Text style={styles.placeText}>Rooted here · nearest first</Text>
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={`Search venues in ${place.name}…`}
        placeholderTextColor={color.faint}
        accessibilityLabel="Search venues"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.search}
      />

      {/* Category pills — All plus the ten canonical groups. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillRow}
      >
        <CategoryChip
          label="All"
          icon="widgets"
          active={activeCategory === null}
          onPress={() => onPickCategory(null)}
        />
        {CATEGORY_GROUPS.map((group) => (
          <CategoryChip
            key={group}
            label={categoryLabel(group)}
            icon={categoryIcon(group)}
            active={activeCategory === group}
            onPress={() => onPickCategory(group)}
          />
        ))}
      </ScrollView>

      {/* Sub-category strip — leaf types within the loaded category view. */}
      {subCategories.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.subRow}
        >
          <Pressable onPress={() => setActiveSub(null)}>
            <Pill variant={activeSub === null ? "crim" : "neutral"} size="sm">
              All
            </Pill>
          </Pressable>
          {subCategories.map((leaf) => (
            <Pressable key={leaf} onPress={() => setActiveSub(leaf)}>
              <Pill variant={activeSub === leaf ? "crim" : "neutral"} size="sm">
                {leafLabel(leaf)}
              </Pill>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  /** The states that replace the list body. Null when there are cards to show. */
  function bodyState() {
    if (venuesQuery.isError) {
      return (
        <Card flat style={styles.state}>
          <Text style={styles.stateTitle}>Couldn&rsquo;t load venues</Text>
          <Text style={styles.stateBody}>
            {venuesQuery.error instanceof Error
              ? venuesQuery.error.message
              : "Failed to load venues."}
          </Text>
        </Card>
      );
    }
    if (venuesQuery.isPending) {
      return (
        <View style={styles.skeletons}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.cardSkeleton} />
          ))}
        </View>
      );
    }
    if (shown.length === 0) {
      if (searching) {
        return (
          <Card flat style={styles.state}>
            <Text style={styles.stateTitle}>Searching for &ldquo;{debouncedQuery}&rdquo;…</Text>
            <Text style={styles.stateBody}>Checking Roam for this place.</Text>
          </Card>
        );
      }
      if (query.trim().length >= 3) {
        return (
          <Card flat style={styles.state}>
            <Text style={styles.stateTitle}>No match found</Text>
            <Text style={styles.stateBody}>
              We couldn&rsquo;t find that place on Roam. Check the spelling, or try a shorter name.
            </Text>
          </Card>
        );
      }
      return (
        <Card flat style={styles.state}>
          <Text style={styles.stateTitle}>Nothing here yet</Text>
          <Text style={styles.stateBody}>
            No venues match this view. Try another category, or check back as Roam grows in your
            area.
          </Text>
        </Card>
      );
    }
    return null;
  }

  const state = bodyState();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <FlatList
        data={state ? [] : visible}
        keyExtractor={(v) => v.id}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={state}
        renderItem={({ item }) => (
          <View style={styles.cardWrap}>
            <VenueCard
              venue={item}
              initialFollowing={followingSet.has(item.id)}
              coverUrl={coverUrls[item.id]}
            />
          </View>
        )}
        ListFooterComponent={
          !state && visibleCount < shown.length ? (
            <Pressable
              onPress={() => setVisibleCount((c) => c + PAGE_SIZE)}
              style={styles.loadMore}
            >
              <Pill variant="neutral">Load more · {shown.length - visibleCount} more</Pill>
            </Pressable>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

/** One icon-led category chip. Crimson-filled when active, quiet outline otherwise. */
function CategoryChip({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        active ? styles.chipActive : null,
        pressed ? styles.chipPressed : null,
      ]}
    >
      <Icon name={icon} size={16} color={active ? color.card : color.crimson700} />
      <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.paper },
  content: { paddingHorizontal: space[4], paddingTop: space[4], paddingBottom: space[16] },

  title: { ...text.h1, letterSpacing: -0.64, color: color.ink },
  placeLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  placeText: { fontFamily: family.ui, fontSize: 13.5, color: color.ink2 },

  search: {
    marginTop: space[4],
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: color.paper2,
    borderWidth: 1,
    borderColor: color.line,
    fontFamily: family.ui,
    // 16px: anything smaller invites the platform to zoom a focused field.
    fontSize: 16,
    color: color.ink,
  },

  pillRow: { gap: space[2], paddingVertical: space[3], paddingRight: space[4] },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
    minHeight: 40,
  },
  chipActive: { backgroundColor: color.crimson, borderColor: color.crimson },
  chipPressed: { opacity: 0.82 },
  chipLabel: { fontFamily: family.uiSemi, fontSize: 13, color: color.ink },
  chipLabelActive: { color: color.card },

  subRow: { gap: space[2], paddingBottom: space[3], paddingRight: space[4] },

  cardWrap: { marginBottom: space[4] },
  skeletons: { gap: space[4] },
  cardSkeleton: { height: 260, borderRadius: 20, backgroundColor: color.paper2 },

  state: { padding: space[5], gap: 6 },
  stateTitle: { fontFamily: family.display, fontSize: 17, color: color.inkHi },
  stateBody: { fontFamily: family.ui, fontSize: 14, lineHeight: 22, color: color.ink2 },

  loadMore: { alignItems: "center", marginTop: space[2] },
});
