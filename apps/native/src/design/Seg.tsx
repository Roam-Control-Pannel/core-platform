/**
 * Seg — the native port of @roam/design's Seg (`.seg`), the segmented control behind the
 * feed's For you / Following / Nearby switch.
 *
 * Same anatomy as web: a sunken paper-2 track, the active option a raised white pill.
 * Controlled — the caller owns `value` and `onChange`.
 */
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { color } from "@roam/design/tokens";
import { family } from "./text";
import { sh1 } from "./shadow";

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export interface SegProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}

export function Seg<T extends string>({ options, value, onChange, style }: SegProps<T>) {
  return (
    <View style={[styles.track, style]}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active ? styles.segmentActive : null]}
          >
            <Text style={[styles.label, active ? styles.labelActive : null]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    alignSelf: "flex-start",
    backgroundColor: color.paper2,
    borderRadius: 999,
    padding: 4,
    gap: 2,
  },
  segment: { paddingHorizontal: 15, paddingVertical: 8, borderRadius: 999 },
  segmentActive: { backgroundColor: color.card, ...sh1 },
  label: { fontFamily: family.uiSemi, fontSize: 12.5, color: color.muted },
  labelActive: { color: color.inkHi },
});
