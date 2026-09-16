/**
 * RN translations of @roam/design's elevation tokens.
 *
 * The tokens themselves are CSS shadow strings (`0 1px 2px …, 0 8px 24px …`) because web is
 * their first consumer. RN's shadow model can't express a multi-layer shadow, so each token
 * gets ONE hand-tuned RN equivalent here — same shadow colour (ink), same visual weight,
 * with `elevation` carrying Android (which ignores shadowOffset/Opacity/Radius entirely).
 *
 * These are the only design values in the native tree that aren't read straight from the
 * token objects; they're a platform translation of a token, not a new value. Keep them in
 * step with `elevation` in packages/design/src/tokens/space.ts.
 */
import type { ViewStyle } from "react-native";

/** L1 cards — elevation.sh1 */
export const sh1: ViewStyle = {
  shadowColor: "#211D1A",
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.06,
  shadowRadius: 2,
  elevation: 1,
};

/** L2 popovers / raised surfaces — elevation.shadowKey */
export const shadowKey: ViewStyle = {
  shadowColor: "#211D1A",
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 0.08,
  shadowRadius: 14,
  elevation: 3,
};

/** L3 sheets / modals — elevation.shadowPop */
export const shadowPop: ViewStyle = {
  shadowColor: "#211D1A",
  shadowOffset: { width: 0, height: 14 },
  shadowOpacity: 0.16,
  shadowRadius: 28,
  elevation: 8,
};
