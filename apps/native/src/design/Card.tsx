/**
 * Card — the native port of @roam/design's Card (`.card-hi`).
 *
 * Same surface language as web: a 20px radius (the hi-fi card's own value, between the
 * lg and xl radius tokens), a hairline rather than a drawn border, and the diffuse key
 * shadow doing the lifting. `flat` keeps the drawn border and drops the shadow, for
 * empty/quiet states that shouldn't float.
 */
import { View, StyleSheet, type ViewProps, type ViewStyle, type StyleProp } from "react-native";
import { color } from "@roam/design/tokens";
import { shadowKey } from "./shadow";

export interface CardProps extends ViewProps {
  flat?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Card({ flat = false, style, children, ...rest }: CardProps) {
  return (
    <View style={[styles.base, flat ? styles.flat : styles.raised, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: color.card,
    borderRadius: 20,
    borderWidth: 1,
    // The web card's hairline is rgba(33,29,26,.05) — the ink token at 5%.
    borderColor: "rgba(33,29,26,0.05)",
  },
  raised: shadowKey,
  flat: { borderColor: color.line },
});
