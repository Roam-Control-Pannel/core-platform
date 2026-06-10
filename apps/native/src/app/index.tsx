import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, Text, View } from "react-native";
import { distanceMetres, formatDistance, type LatLng } from "@roam/core/geo";

// CHUNK 2 PROOF: this screen imports pure functions from @roam/core/geo and
// renders their output. If the number below is correct (~200 km), Metro has
// resolved and transpiled the shared core's raw TypeScript — the "one core,
// native shell" thesis holds on device.
const DARLINGTON: LatLng = { lat: 54.5253, lng: -1.5849 };
const LONDON: LatLng = { lat: 51.5074, lng: -0.1278 };

export default function HomeScreen() {
  const metres = distanceMetres(DARLINGTON, LONDON);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.brand}>Roam</Text>
        <Text style={styles.tagline}>native shell — Stage 4</Text>
        <View style={styles.proof}>
          <Text style={styles.proofLabel}>@roam/core/geo says</Text>
          <Text style={styles.proofValue}>
            Darlington → London: {formatDistance(metres)}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  brand: { fontSize: 34, fontWeight: "700" },
  tagline: { fontSize: 14, opacity: 0.6 },
  proof: { marginTop: 32, alignItems: "center", gap: 4 },
  proofLabel: { fontSize: 12, opacity: 0.5, textTransform: "uppercase", letterSpacing: 1 },
  proofValue: { fontSize: 18, fontWeight: "600" },
});
