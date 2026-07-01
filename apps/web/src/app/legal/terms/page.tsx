/**
 * Terms of Service / EULA. Placeholder skeleton — replace the body with the final copy and remove
 * the `draft` flag on <LegalDoc>. The section headings below are a suggested skeleton only.
 */
import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalDoc title="Terms of Service" draft>
      <p>
        <strong>Placeholder.</strong> Replace this page&apos;s content with the final Terms of
        Service / End User Licence Agreement. The structure below is only a starting skeleton.
      </p>
      <h2>1. Acceptance of these terms</h2>
      <p>Summary of what agreeing to these terms means, and who they apply to.</p>
      <h2>2. Your account</h2>
      <p>Eligibility, account security, and acceptable use.</p>
      <h2>3. Content and conduct</h2>
      <p>What users may post, ownership, and the licence granted to Roam.</p>
      <h2>4. Businesses and listings</h2>
      <p>Terms specific to claimed venues, offers and promotions.</p>
      <h2>5. Termination</h2>
      <p>How either party may end the agreement, and the effect of account deletion.</p>
      <h2>6. Liability and disclaimers</h2>
      <p>Limitations of liability and warranty disclaimers.</p>
      <h2>7. Contact</h2>
      <p>How to reach Roam about these terms.</p>
    </LegalDoc>
  );
}
