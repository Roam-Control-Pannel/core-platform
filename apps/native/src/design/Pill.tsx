/**
 * Pill — the native port of @roam/design's Pill (`.pill`).
 *
 * Same states as web: default (white, neutral border), on (ink-filled — the active chip),
 * crim (crimson-filled), ghost-crim (borderless crimson tint). Modifier: sm. Used for
 * category chips, kind chips, counts.
 *
 * Presentation only — a Pill is a label, not a control. Wrap it in a Pressable where a
 * chip needs to be tappable (as web wraps it in a link).
 */
import { View, Text, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from "react-native";
import type { ReactNode } from "react";
import { color } from "@roam/design/tokens";
import { family } from "./text";

export type PillVariant = "neutral" | "on" | "crim" | "ghost-crim";

export interface PillProps {
  children: ReactNode;
  variant?: PillVariant;
  size?: "md" | "sm";
  style?: StyleProp<ViewStyle>;
}

export function Pill({ children, variant = "neutral", size = "md", style }: PillProps) {
  return (
    <View style={[styles.base, variantView[variant], size === "sm" ? styles.sm : null, style]}>
      <Text style={[styles.label, variantText[variant], size === "sm" ? styles.labelSm : null]}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: color.line2,
    backgroundColor: color.card,
    alignSelf: "flex-start",
  },
  sm: { paddingHorizontal: 11, paddingVertical: 5 },
  label: { fontFamily: family.uiSemi, fontSize: 13, color: color.ink2 },
  labelSm: { fontSize: 11.5 },
});

const variantView: Record<PillVariant, StyleProp<ViewStyle>> = {
  neutral: null,
  on: { backgroundColor: color.inkHi, borderColor: color.inkHi },
  crim: { backgroundColor: color.crimson, borderColor: color.crimson },
  // Borderless tint chip, per the hi-fi mockup (the "Offer" / locality chips).
  "ghost-crim": { backgroundColor: color.crimsonTint, borderColor: "transparent" },
};

const variantText: Record<PillVariant, StyleProp<TextStyle>> = {
  neutral: null,
  on: { color: color.card },
  crim: { color: color.card },
  "ghost-crim": { color: color.crimson700 },
};
