export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { SettingsHub } from "../../components/SettingsHub";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <SettingsHub />;
}
