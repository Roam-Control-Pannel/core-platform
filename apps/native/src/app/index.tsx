import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, Text, View } from "react-native";

// The clean shell's single screen. Chunk 1 proves the scaffold boots; chunk 2
// will render real @roam/core output here to prove Metro resolves the shared
// core where Turbopack could not.
export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <Text style={styles.brand}>Roam</Text>
        <Text style={styles.tagline}>native shell — Stage 4</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  brand: { fontSize: 34, fontWeight: "700" },
  tagline: { fontSize: 14, opacity: 0.6 },
});
