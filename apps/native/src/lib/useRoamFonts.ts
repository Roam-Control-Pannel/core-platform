/**
 * useRoamFonts — loads the three families @roam/design's type tokens name.
 *
 * Web gets Space Grotesk / Schibsted Grotesk / Space Mono from Google Fonts over the
 * network; native has to bundle them, so each cut the type scale uses is registered here
 * from its @expo-google-fonts package. The KEYS are the family names — they match the
 * strings in src/design/text.ts exactly, which is what lets the scale reference them.
 *
 * Only the cuts the scale actually maps to are loaded (see `familyFor`): four Schibsted
 * weights for UI, two Space Grotesk for headings, two Space Mono for eyebrows. Loading
 * the unused cuts would just grow the bundle.
 *
 * Returns [loaded, error] straight from expo-font. The caller renders on EITHER — a font
 * that fails to load must not leave the app on a blank splash; RN falls back to the system
 * face and the app is merely off-brand, not broken.
 */
import { useFonts } from "expo-font";
import {
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import {
  SchibstedGrotesk_400Regular,
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
} from "@expo-google-fonts/schibsted-grotesk";
import { SpaceMono_400Regular, SpaceMono_700Bold } from "@expo-google-fonts/space-mono";

export function useRoamFonts(): [boolean, Error | null] {
  const [loaded, error] = useFonts({
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    SchibstedGrotesk_400Regular,
    SchibstedGrotesk_500Medium,
    SchibstedGrotesk_600SemiBold,
    SchibstedGrotesk_700Bold,
    SpaceMono_400Regular,
    SpaceMono_700Bold,
  });
  return [loaded, error];
}
