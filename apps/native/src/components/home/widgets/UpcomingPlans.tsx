/**
 * UpcomingPlans — your plans as a horizontal track of image cards, ported from web's
 * UpcomingPlans widget.
 *
 * Auth-gated (plans.list is protected), with the same sign-in nudge the other gated
 * sections show. A plan without its own header photo falls back to the calm crimson
 * gradient web uses on PlanDetail and PlansList, so the track never has a blank tile.
 *
 * The gradient is drawn as three stacked bands rather than a real linear-gradient: RN has
 * no gradient primitive, and the alternative is pulling in expo-linear-gradient for one
 * decorative fill. Same crimson→deep sweep, no new dependency.
 */
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { color, space } from "@roam/design/tokens";
import { Button, family } from "../../../design";
import { useTrpc, useSession } from "../../../lib/TrpcProvider";
import { planDateLabel, plural } from "../../../lib/format";
import { Section } from "../Section";
import { SignInNudge } from "../SignInNudge";
import { common } from "../common";

const NUDGE = "Make plans — a night out, a weekend, a list to try — and save venues to them.";

interface PlanRow {
  id: string;
  title: string;
  plannedFor: string | null;
  headerUrl: string | null;
  venueCount: number;
}

export function UpcomingPlans() {
  const trpc = useTrpc();
  const session = useSession();
  const signedIn = !!session;

  const q = useQuery({
    queryKey: ["plans.list"],
    queryFn: () => trpc.plans.list.query(),
    enabled: signedIn,
  });

  const plans = ((q.data?.plans ?? []) as PlanRow[]).slice(0, 6);

  return (
    <Section title="Your plans" icon="plan">
      {!signedIn ? (
        <SignInNudge note={NUDGE} />
      ) : q.isError ? (
        <Text style={common.mutedNote}>Couldn&rsquo;t load your plans just now.</Text>
      ) : q.isPending ? (
        <View style={styles.skeletons}>
          <View style={common.rowSkeleton} />
          <View style={common.rowSkeleton} />
        </View>
      ) : plans.length === 0 ? (
        <View>
          <Text style={common.mutedNote}>
            No plans yet — start one and add venues from anywhere on Roam.
          </Text>
          <View style={styles.cta}>
            <Button variant="neutral" size="sm" disabled>
              ＋ New plan
            </Button>
          </View>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.track}
        >
          {plans.map((p) => (
            <View key={p.id} style={styles.planCard}>
              {p.headerUrl ? (
                <Image
                  source={{ uri: p.headerUrl }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={180}
                  accessibilityIgnoresInvertColors
                />
              ) : (
                <View style={StyleSheet.absoluteFill}>
                  <View style={[styles.band, { backgroundColor: color.crimson }]} />
                  <View style={[styles.band, { backgroundColor: color.crimson700 }]} />
                  <View style={[styles.band, { backgroundColor: "#7a0c28" }]} />
                </View>
              )}
              {/* Scrim, so white type stays legible over any photo. */}
              <View style={styles.scrim} />
              <View style={styles.planBody}>
                <View style={styles.datePill}>
                  <Text style={styles.dateText}>
                    {p.plannedFor ? planDateLabel(p.plannedFor) : "No date yet"}
                  </Text>
                </View>
                <Text style={styles.planTitle} numberOfLines={2}>
                  {p.title}
                </Text>
                <Text style={styles.planMeta}>{plural(p.venueCount, "venue", "venues")}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  skeletons: { gap: space[2] },
  cta: { marginTop: space[3], alignItems: "flex-start" },
  track: { gap: space[3], paddingRight: space[1] },
  planCard: {
    width: 240,
    minHeight: 140,
    borderRadius: 18,
    overflow: "hidden",
    justifyContent: "flex-end",
    borderWidth: 1,
    borderColor: color.line,
  },
  band: { flex: 1 },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.28)" },
  planBody: { padding: space[4], gap: 6 },
  datePill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  dateText: {
    fontFamily: family.mono,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: color.card,
  },
  planTitle: { fontFamily: family.display, fontSize: 16, lineHeight: 21, color: color.card },
  planMeta: { fontFamily: family.ui, fontSize: 12, color: "rgba(255,255,255,0.85)" },
});
