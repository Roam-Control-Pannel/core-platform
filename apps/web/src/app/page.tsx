/**
 * Explore is the web app's home. The TrpcProvider supplies the typed client (wired to
 * the live Supabase session) to everything beneath it; Explore is its first consumer.
 */
import { TrpcProvider } from "../components/TrpcProvider";
import { Explore } from "../components/Explore";

export default function Home() {
  return (
    <TrpcProvider>
      <Explore />
    </TrpcProvider>
  );
}
