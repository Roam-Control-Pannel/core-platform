/**
 * MarketSeam — the local marketplace card, ported from web's MarketSeam widget.
 *
 * Copy and shape follow web exactly; the CTA is disabled because the Market screen is not
 * part of this slice. A visibly disabled button is the honest state — it says the surface
 * exists and isn't reachable yet, rather than looking live and doing nothing.
 */
import { View, Text, StyleSheet } from "react-native";
import { space } from "@roam/design/tokens";
import { Button } from "../../../design";
import type { Place } from "../../../lib/useCurrentPlace";
import { Section } from "../Section";
import { common } from "../common";

export function MarketSeam({ place }: { place: Place }) {
  return (
    <Section title={`${place.name} market`} icon="shop">
      <Text style={common.mutedNote}>
        Buy, sell and swap with people in your town — list something in a minute, agree in chat,
        meet locally.
      </Text>
      <View style={styles.cta}>
        <Button variant="neutral" size="sm" disabled>
          Open the Market
        </Button>
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  cta: { marginTop: space[3], alignItems: "flex-start" },
});
