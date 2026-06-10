import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

// Root layout for @roam/native — a single Stack navigator. The Discover surface
// and the rest of the app hang off this as Stage 4 builds out. Deliberately
// minimal: this is the clean shell that proves the spine, not the final shape.
export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </>
  );
}
