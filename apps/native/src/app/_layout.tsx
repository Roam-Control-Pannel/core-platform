import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { TrpcProvider } from "../lib/TrpcProvider";
import { useAuthDeepLink } from "../lib/useAuthDeepLink";

// Root layout for @roam/native. QueryClientProvider supplies @tanstack/react-query;
// TrpcProvider (nested inside it) tracks the Supabase session, rebuilds the typed tRPC
// client when the token changes, and exposes useTrpc()/useSession() to every screen —
// the same contract the web surface uses. Public browsing works with a null session
// (just-in-time auth); signing in flows a live JWT through to RLS-scoped requests.
export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient());

  // Catch the email-confirmation deep link and turn it into a session.
  useAuthDeepLink();

  return (
    <QueryClientProvider client={queryClient}>
      <TrpcProvider>
        <Stack screenOptions={{ headerShown: false }} />
        <StatusBar style="auto" />
      </TrpcProvider>
    </QueryClientProvider>
  );
}
