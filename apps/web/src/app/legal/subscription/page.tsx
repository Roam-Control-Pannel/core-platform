/**
 * Subscription Terms. Placeholder skeleton — replace the body with the final copy and remove the
 * `draft` flag on <LegalDoc>. The section headings below are a suggested skeleton only.
 */
import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";

export const metadata: Metadata = { title: "Subscription Terms" };

export default function SubscriptionPage() {
  return (
    <LegalDoc title="Subscription Terms" draft>
      <p>
        <strong>Placeholder.</strong> Replace this page&apos;s content with the final Subscription /
        billing agreement. The structure below is only a starting skeleton.
      </p>
      <h2>1. Plans and pricing</h2>
      <p>What each paid plan includes and how pricing is shown.</p>
      <h2>2. Billing and renewal</h2>
      <p>Billing cycle, automatic renewal, and payment methods.</p>
      <h2>3. Trials and promotions</h2>
      <p>How trials convert and how promotional pricing works.</p>
      <h2>4. Cancellation and refunds</h2>
      <p>How to cancel, when access ends, and the refund policy.</p>
      <h2>5. Changes to a plan</h2>
      <p>Upgrades, downgrades and price changes.</p>
      <h2>6. Contact</h2>
      <p>Billing support and how to reach us.</p>
    </LegalDoc>
  );
}
