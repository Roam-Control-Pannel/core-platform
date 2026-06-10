import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

// Root layout for @roam/native. Wraps the app in a QueryClientProvider so
// screens can fetch via @tanstack/react-query. The tRPC client itself is
// created per-screen for now (chunk 3 is a single read-only Discover screen);
// a shared TrpcProvider mirroring the web surface comes when auth lands.
export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </QueryClientProvider>
  );
}
