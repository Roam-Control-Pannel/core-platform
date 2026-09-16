/**
 * Button — the native port of @roam/design's Button (`.btn-hi`).
 *
 * Same variants as web (neutral · pri · dark · ghost), same modifiers (block, sm), same
 * fully-rounded pill shape. Colours read from the shared tokens, so a token change
 * repaints both surfaces together.
 *
 * Usage rule honoured by convention, as on web: one crimson (variant="pri") CTA per view.
 *
 * RN specifics: a Pressable (not a <button>), with `pressed` opacity standing in for the
 * web hover state — touch has no hover — and a 44pt minimum height so every button clears
 * the platform tap target.
 */
import {
  Pressable,
  Text,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import type { ReactNode } from "react";
import { color } from "@roam/design/tokens";
import { family } from "./text";
import { sh1 } from "./shadow";

export type ButtonVariant = "neutral" | "pri" | "dark" | "ghost";

export interface ButtonProps {
  children: ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  block?: boolean;
  size?: "md" | "sm";
  disabled?: boolean;
  /** Optional leading node (an Icon, usually) rendered before the label. */
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Button({
  children,
  onPress,
  variant = "neutral",
  block = false,
  size = "md",
  disabled = false,
  icon,
  style,
  accessibilityLabel,
}: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      style={({ pressed }) => [
        styles.base,
        variantView[variant],
        size === "sm" ? styles.sm : null,
        block ? styles.block : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      {icon}
      <Text style={[styles.label, variantText[variant], size === "sm" ? styles.labelSm : null]}>
        {children}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 11,
    // Touch target: the web button is 40px tall; native needs 44.
    minHeight: 44,
    borderWidth: 1,
    borderColor: color.line2,
    backgroundColor: color.card,
    ...sh1,
  },
  sm: { paddingHorizontal: 15, paddingVertical: 8, minHeight: 40 },
  block: { alignSelf: "stretch" },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.45 },
  label: { fontFamily: family.uiSemi, fontSize: 13.5, color: color.inkHi },
  labelSm: { fontSize: 12.5 },
});

const variantView: Record<ButtonVariant, StyleProp<ViewStyle>> = {
  neutral: null,
  pri: {
    backgroundColor: color.crimson,
    borderColor: color.crimson,
    // The web primary carries a crimson-tinted glow rather than the neutral ink shadow.
    shadowColor: color.crimson,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.24,
    shadowRadius: 12,
    elevation: 3,
  },
  dark: { backgroundColor: color.inkHi, borderColor: color.inkHi },
  ghost: {
    backgroundColor: "rgba(255,255,255,0.16)",
    borderColor: "rgba(255,255,255,0.4)",
    shadowOpacity: 0,
    elevation: 0,
  },
};

const variantText: Record<ButtonVariant, StyleProp<TextStyle>> = {
  neutral: null,
  pri: { color: color.card },
  dark: { color: color.card },
  ghost: { color: color.card },
};
