/**
 * Section — the card shell every Home widget renders inside. A faithful port of the
 * `Section` in web's Home.tsx: an icon chip, a display-face title, an optional count pill,
 * an optional action affordance on the right, then the section's own content.
 *
 * The action is an `onPress` rather than web's `href` — native navigation is imperative.
 * Sections whose web destination has no native route yet simply pass no action; the
 * affordance appears the moment a route does, without the section changing shape.
 */
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ReactNode } from "react";
import { color, space } from "@roam/design/tokens";
import { Card, Pill, Icon, family, type IconName } from "../../design";
import { common } from "./common";

export interface SectionAction {
  label: string;
  onPress: () => void;
}

export interface SectionProps {
  title: string;
  icon: IconName;
  /** Shown as a small neutral pill beside the title when greater than zero. */
  count?: number;
  action?: SectionAction;
  children: ReactNode;
}

export function Section({ title, icon, count, action, children }: SectionProps) {
  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerMain}>
          <View style={common.iconChip}>
            <Icon name={icon} size={15} color={color.crimson700} />
          </View>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {count != null && count > 0 ? (
            <Pill variant="neutral" size="sm">
              {count}
            </Pill>
          ) : null}
        </View>
        {action ? (
          <Pressable
            onPress={action.onPress}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
          >
            <Text style={styles.actionLabel}>{action.label}</Text>
            <Icon name="chevronRight" size={14} color={color.crimson700} />
          </Pressable>
        ) : null}
      </View>
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: space[4] },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[3],
    marginBottom: space[3],
  },
  headerMain: { flexDirection: "row", alignItems: "center", gap: space[2], flex: 1 },
  // 17px display face — web's Section title overrides the h3 token down to 17.
  title: { fontFamily: family.display, fontSize: 17, color: color.ink, flexShrink: 1 },
  action: { flexDirection: "row", alignItems: "center", gap: 2 },
  actionPressed: { opacity: 0.6 },
  actionLabel: { fontFamily: family.uiSemi, fontSize: 13, color: color.crimson700 },
});
