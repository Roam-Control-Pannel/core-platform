/**
 * Privacy Policy. Placeholder skeleton — replace the body with the final copy and remove the
 * `draft` flag on <LegalDoc>. The section headings below are a suggested skeleton only.
 */
import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalDoc title="Privacy Policy" draft>
      <p>
        <strong>Placeholder.</strong> Replace this page&apos;s content with the final Privacy
        Policy. The structure below is only a starting skeleton.
      </p>
      <h2>1. Who we are</h2>
      <p>The data controller and how to contact us.</p>
      <h2>2. What we collect</h2>
      <p>Account details, content you post, location you set, and usage data.</p>
      <h2>3. How we use it</h2>
      <p>Providing the service, safety and moderation, and communications.</p>
      <h2>4. Sharing</h2>
      <p>Service providers (e.g. hosting, email, transit data) and legal disclosures.</p>
      <h2>5. Your rights</h2>
      <p>
        Access, correction, portability and erasure. You can delete your account at any time from{" "}
        <a href="/settings">Settings</a>.
      </p>
      <h2>6. Retention and security</h2>
      <p>How long we keep data and how we protect it.</p>
      <h2>7. Contact</h2>
      <p>How to reach us or raise a complaint.</p>
    </LegalDoc>
  );
}
