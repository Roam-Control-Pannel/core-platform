/**
 * HomeHeader — the top of the Home wall: a mono uppercase date kicker, the time-aware
 * greeting, and the "here's what's moving in <place>" line carrying the place chip.
 *
 * Ported from the <header> in web's Home.tsx. The kicker ticks every minute, exactly as
 * web's does; on native there's no SSR/client clock disagreement to avoid, but a header
 * showing a stale time is still wrong, so the interval stays.
 *
 * The place chip is presentational for now — it reports where the sections are rooted.
 * Web makes it a PlaceSwitcher (search · saved · suggested); wiring that on native is a
 * later slice, and it drops in here without the rest of Home changing.
 */
import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { color, space } from "@roam/design/tokens";
import { Icon, family, text } from "../../design";
import { dateKicker, greeting } from "../../lib/format";
import type { CurrentPlace } from "../../lib/useCurrentPlace";

export interface HomeHeaderProps {
  current: CurrentPlace;
  /** First name for the greeting, when we know it. */
  firstName: string | null;
}

export function HomeHeader({ current, firstName }: HomeHeaderProps) {
  const [kicker, setKicker] = useState(() => dateKicker());

  useEffect(() => {
    const id = setInterval(() => setKicker(dateKicker()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={styles.header}>
      <Text style={styles.kicker}>{kicker}</Text>
      <Text style={styles.greeting}>
        {greeting()}
        {firstName ? `, ${firstName}` : ""}
      </Text>
      <View style={styles.placeLine}>
        <Text style={styles.movingIn}>Here&rsquo;s what&rsquo;s moving in</Text>
        <View style={styles.placeChip}>
          <Icon name="place" size={13} color={color.crimson700} />
          <Text style={styles.placeName}>{current.place.name}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: space[4] },
  kicker: {
    fontFamily: family.monoBold,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: color.crimson700,
    marginBottom: 6,
  },
  // The h1 token at Home's own tighter tracking (-.02em), as the web header sets it.
  greeting: { ...text.h1, letterSpacing: -0.64, color: color.ink },
  placeLine: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space[2],
  },
  movingIn: { fontFamily: family.ui, fontSize: 14.5, color: color.ink2 },
  placeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.line,
  },
  placeName: { fontFamily: family.uiSemi, fontSize: 13, color: color.ink },
});
