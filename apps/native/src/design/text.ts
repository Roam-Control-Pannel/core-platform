/**
 * Native type scale — the RN half of @roam/design's typography.
 *
 * Web turns the `type` tokens into CSS classes (typeScaleCss); native turns the SAME
 * tokens into RN TextStyles here. Two consumers, one source: a token change repaints
 * both surfaces, which is the whole point of the one-design-system architecture.
 *
 * Two RN-specific translations the web side doesn't need:
 *   1. FAMILY-PER-WEIGHT. RN can't synthesise weight for a custom font — asking for
 *      fontWeight 600 on a loaded family silently renders the regular cut (or the
 *      wrong one on Android). So each weight is its own registered family, and the
 *      scale maps a token's `weight` to the matching cut via `familyFor`.
 *   2. TRACKING IN PX. The tokens carry letter-spacing in `em` (CSS); RN's
 *      letterSpacing is absolute. We multiply by the token's own size.
 */
import type { TextStyle } from "react-native";
import { type as typeScale, font } from "@roam/design/tokens";

/**
 * The registered font families, one per cut we actually use. Names are the export names
 * from the @expo-google-fonts packages — which are also the keys `useFonts` registers
 * them under (see useRoamFonts), so these strings ARE the RN family names.
 */
export const family = {
  /** Space Grotesk — headings, brand moments. */
  display: "SpaceGrotesk_600SemiBold",
  displayBold: "SpaceGrotesk_700Bold",
  /** Schibsted Grotesk — the UI/body workhorse. */
  ui: "SchibstedGrotesk_400Regular",
  uiMedium: "SchibstedGrotesk_500Medium",
  uiSemi: "SchibstedGrotesk_600SemiBold",
  uiBold: "SchibstedGrotesk_700Bold",
  /** Space Mono — eyebrows / data labels, uppercase + tracked. */
  mono: "SpaceMono_400Regular",
  monoBold: "SpaceMono_700Bold",
} as const;

/**
 * Pick the registered family for a (token family, weight) pair. The token spec says
 * "Space Grotesk 600" or "Schibsted Grotesk 400"; this resolves that to a real RN family.
 */
function familyFor(tokenFamily: string, weight: number): string {
  if (tokenFamily === font.display) return weight >= 700 ? family.displayBold : family.display;
  if (tokenFamily === font.mono) return weight >= 700 ? family.monoBold : family.mono;
  if (weight >= 700) return family.uiBold;
  if (weight >= 600) return family.uiSemi;
  if (weight >= 500) return family.uiMedium;
  return family.ui;
}

/** Turn one type token into an RN TextStyle (em tracking → absolute px). */
function styleFor(spec: (typeof typeScale)[keyof typeof typeScale]): TextStyle {
  return {
    fontFamily: familyFor(spec.family, spec.weight),
    fontSize: spec.size,
    letterSpacing: spec.tracking * spec.size,
  };
}

/**
 * The type scale as RN styles — the native mirror of web's `.t-display` … `.t-mono-label`.
 * `monoLabel` also carries the uppercasing the CSS helper applies.
 */
export const text = {
  display: styleFor(typeScale.display),
  h1: styleFor(typeScale.h1),
  h2: styleFor(typeScale.h2),
  h3: styleFor(typeScale.h3),
  body: styleFor(typeScale.body),
  bodyS: styleFor(typeScale.bodyS),
  monoLabel: { ...styleFor(typeScale.monoLabel), textTransform: "uppercase" } as TextStyle,
} as const;
