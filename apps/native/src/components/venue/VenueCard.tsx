/**
 * VenueCard — a venue from venues.near / venues.inCategoryNear, ported from web's VenueCard.
 *
 * Two first-class states, same design intent as web:
 *
 *  - CLAIMED (owner_id set): cover, name, ★rating · type · price, and a footer with the
 *    "Claimed" trust chip beside the Follow action.
 *  - UNCLAIMED: at launch nearly every seeded venue is unclaimed, so this must look
 *    INTENTIONAL, not provisional. It gets the same border and the same cover treatment;
 *    the single unclaimed signal is the quiet "Claim it free" pill, with "From public
 *    sources" receding to a faint footnote. No rating fabrication — if there isn't one, the
 *    meta row simply omits it.
 *
 * Cover: the venue's Places/owner photo when the caller has resolved its URL (Explore
 * batches those, so a grid doesn't do N round-trips), otherwise the tinted fallback tile at
 * the SAME height, so swapping in a real photo causes no layout shift. Web's fallback is an
 * illustrated SVG from /public; native has no such asset, so the fallback is a tinted tile
 * with a pin glyph — warm and on-brand rather than a grey box.
 *
 * Distance: rendered only when the row actually carries `distanceM` (the near/inCategoryNear
 * reads compute it in PostGIS). A card fed from a name search has none, and we never fake one.
 *
 * Memoised: Explore re-renders on unrelated state (search text, sub-filter, cover batches)
 * and the props here are primitives over a stable venue ref, so a shallow memo skips the
 * whole grid's reconciliation on those.
 */
import { memo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
// The SUBPATH, not the "@roam/core" barrel: the barrel re-exports every module with
// Node-ESM ".js" suffixes that Metro cannot resolve, so importing it fails the bundle
// (tsc resolves it fine, so only a real bundle catches this).
import { formatDistance } from "@roam/core/geo";
import { color, space } from "@roam/design/tokens";
import { Card, Icon, family } from "../../design";
import { formatRatingCount, priceLevelLabel } from "../../lib/format";
import { FollowButton } from "./FollowButton";

/** The fields a card renders. Optional ones are genuinely absent on some reads. */
export interface VenueCardData {
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
}

export interface VenueCardProps {
  venue: VenueCardData;
  initialFollowing?: boolean;
  /** Resolved cover URL, batched by the caller. Undefined → the fallback tile. */
  coverUrl?: string | undefined;
}

/** Prefer Google's clean type label; fall back to our coarse category group. */
function typeLabel(venue: VenueCardData): string | null {
  return venue.primaryTypeLabel?.trim() || venue.category || null;
}

export const VenueCard = memo(function VenueCard({
  venue,
  initialFollowing = false,
  coverUrl,
}: VenueCardProps) {
  const closed = venue.businessStatus === "CLOSED_TEMPORARILY";
  const label = typeLabel(venue);
  const price = priceLevelLabel(venue.priceLevel);
  const hasRating = venue.rating != null;

  return (
    <Card style={styles.card}>
      {/* Cover + its overlays */}
      <View style={styles.cover}>
        {coverUrl ? (
          <Image
            source={{ uri: coverUrl }}
            style={styles.coverImage}
            contentFit="cover"
            transition={180}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={styles.fallback}>
            <Icon name="place" size={26} color={color.crimsonTint2} />
          </View>
        )}
        {venue.distanceM != null ? (
          <View style={styles.distancePill}>
            <Text style={styles.distanceText}>{formatDistance(venue.distanceM)}</Text>
          </View>
        ) : null}
        {closed ? (
          <View style={styles.closedBadge}>
            <Text style={styles.closedText}>Temporarily closed</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>
          {venue.name}
        </Text>
        {hasRating || label || price ? (
          <View style={styles.metaRow}>
            {hasRating ? (
              <View style={styles.ratingCluster}>
                {/* Gold is sanctioned for ★ ratings (and the Gold tier) only. */}
                <Text style={styles.star}>★</Text>
                <Text style={styles.rating}>{venue.rating!.toFixed(1)}</Text>
                {venue.ratingCount != null && venue.ratingCount > 0 ? (
                  <Text style={styles.ratingCount}>
                    ({formatRatingCount(venue.ratingCount)})
                  </Text>
                ) : null}
              </View>
            ) : null}
            {label ? (
              <>
                {hasRating ? <Text style={styles.dot}>·</Text> : null}
                <Text style={styles.metaLabel} numberOfLines={1}>
                  {label}
                </Text>
              </>
            ) : null}
            {price ? (
              <>
                {hasRating || label ? <Text style={styles.dot}>·</Text> : null}
                <Text style={styles.price}>{price}</Text>
              </>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Footer strip: the trust signal on the left, the action on the right. */}
      <View style={styles.footer}>
        {venue.claimed ? (
          <View style={styles.claimedChip}>
            <Icon name="check" size={11} strokeWidth={2.5} color={color.success} />
            <Text style={styles.claimedText}>Claimed</Text>
          </View>
        ) : (
          <View style={styles.provenance}>
            <Text style={styles.provenanceText} numberOfLines={1}>
              From public sources
            </Text>
          </View>
        )}
        {venue.claimed ? (
          <FollowButton venueId={venue.id} initialFollowing={initialFollowing} />
        ) : (
          <View style={styles.claimPill}>
            <Text style={styles.claimPillText}>Claim it free</Text>
          </View>
        )}
      </View>
    </Card>
  );
});

const styles = StyleSheet.create({
  card: { overflow: "hidden" },

  cover: { height: 168, backgroundColor: color.paper2 },
  coverImage: { width: "100%", height: "100%" },
  fallback: {
    width: "100%",
    height: "100%",
    backgroundColor: color.crimsonTint,
    alignItems: "center",
    justifyContent: "center",
  },
  distancePill: {
    position: "absolute",
    top: 10,
    left: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: color.crimsonTint,
  },
  distanceText: {
    fontFamily: family.monoBold,
    fontSize: 11,
    color: color.crimson700,
  },
  closedBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: color.card,
  },
  closedText: {
    fontFamily: family.monoBold,
    fontSize: 9.5,
    letterSpacing: 0.57,
    textTransform: "uppercase",
    color: color.ink2,
  },

  body: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[3], gap: 5 },
  // The h3 token at the card's own tighter tracking.
  name: { fontFamily: family.display, fontSize: 18, lineHeight: 23, letterSpacing: -0.18, color: color.inkHi },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  ratingCluster: { flexDirection: "row", alignItems: "center", gap: 3 },
  star: { color: color.gold, fontSize: 12 },
  rating: { fontFamily: family.uiSemi, fontSize: 12.5, color: color.inkHi },
  ratingCount: { fontFamily: family.ui, fontSize: 12, color: color.muted },
  dot: { color: color.faint, fontSize: 12 },
  metaLabel: { fontFamily: family.ui, fontSize: 12.5, color: color.ink2, flexShrink: 1 },
  price: { fontFamily: family.uiSemi, fontSize: 12.5, color: color.ink2 },

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[2],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  claimedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: color.successTint,
  },
  claimedText: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: color.success,
  },
  provenance: {
    flexShrink: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: color.paper2,
  },
  provenanceText: {
    fontFamily: family.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: color.muted,
  },
  claimPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: color.crimsonTint,
  },
  claimPillText: { fontFamily: family.uiSemi, fontSize: 12, color: color.crimson700 },
});
