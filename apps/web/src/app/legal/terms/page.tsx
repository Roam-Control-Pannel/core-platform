/**
 * Terms of Service.
 *
 * Channel-aware (holistic plan Phase 1.3): on a branded storefront host (the NI Food to Go
 * Association) this renders the STOREFRONT terms — who operates it, how ordering works, the 7%
 * platform fee vendors pay (decision D5), collection/delivery, refunds — instead of Roam's skeleton.
 * The channel resolves per request from the x-roam-channel header, hence force-dynamic.
 *
 * Both documents are marked as working versions: the storefront terms are substantive and apply as
 * written, but they are drafted for review by Roam and the Association (company details, governing
 * law wording and the DPA reference are the known blanks). Roam's own terms remain the original
 * placeholder skeleton until its final copy is written.
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";
import { getChannelInfo } from "../../../lib/serverApi";

export const metadata: Metadata = { title: "Terms of Service" };

export default async function TermsPage() {
  const channel = await getChannelInfo();
  if (channel && !channel.isDefault) return <StorefrontTerms brand={channel.name} />;
  return <RoamTerms />;
}

function StorefrontTerms({ brand }: { brand: string }) {
  return (
    <LegalDoc
      title="Terms of Service"
      lastUpdated="17 September 2026"
      draft
      draftNote={`Working version — prepared for review by Roam and the ${brand} Association. It applies as written until a revised version replaces it.`}
      backHref="/"
      backLabel={brand}
    >
      <h2>1. Who we are and what this is</h2>
      <p>
        This storefront is operated by <strong>Roam</strong> in partnership with the{" "}
        <strong>{brand} Association</strong> (&ldquo;the Association&rdquo;). Roam provides the
        platform: accounts, listings, ordering, payment processing and support tooling. The
        Association brands the storefront and sets who is recognised as a member. When you use this
        site you agree to these terms and to Roam&apos;s{" "}
        <a href="/legal/privacy">Privacy Policy</a>.
      </p>

      <h2>2. Orders are with the venue</h2>
      <p>
        When you place an order, your contract for the food or drink is with the <strong>venue</strong>{" "}
        that prepares it, not with Roam or the Association. Roam takes payment on the venue&apos;s
        behalf and passes it on. Prices are set by the venue and shown at the counter price; the
        estimated ready time is the venue&apos;s own.
      </p>

      <h2>3. Payment and the platform fee</h2>
      <p>
        Payments are processed by <strong>Stripe</strong>. You pay the price shown plus any delivery
        charge the venue sets; there is no consumer fee. For each order, <strong>a platform fee of 7%
        of the food subtotal is deducted from the venue&apos;s payout</strong>; delivery charges go to
        the venue in full. The fee funds the storefront and the platform behind it.
      </p>

      <h2>4. Collection and delivery</h2>
      <p>
        Collection orders carry a collection code — show it at the counter. Delivery, where a venue
        offers it, is limited to the venue&apos;s stated area and minimum order, and the venue
        delivers. If a venue pauses orders, checkout tells you before you pay.
      </p>

      <h2>5. Changes, cancellations and refunds</h2>
      <p>
        Because food is prepared to order, an order cannot normally be cancelled once the venue has
        accepted it. If something is wrong with an order, contact the venue first; a venue can refund
        an order in full through the platform. Statutory rights are not affected.
      </p>

      <h2>6. Your account</h2>
      <p>
        You need an account to order. Keep your sign-in details safe and tell us if you think someone
        else has used them. You must be old enough to enter a contract for what you buy. You may
        delete your account at any time from your account page.
      </p>

      <h2>7. Businesses, members and listings</h2>
      <p>
        Venues appear on the storefront either as Association members or as other local food
        businesses. Membership recognition and priority is decided by the Association; listing a
        business, activating it and taking orders is subject to Roam&apos;s business terms shown in
        the vendor dashboard, including the platform fee in section 3.
      </p>

      <h2>8. Food hygiene ratings</h2>
      <p>
        Food hygiene ratings shown on venue pages are the Food Standards Agency&apos;s, displayed with
        the date they were awarded and the date we last checked. They are provided for information;
        the rating belongs to the FSA and the responsible council, not to Roam or the Association.
      </p>

      <h2>9. Acceptable use and content</h2>
      <p>
        Don&apos;t misuse the storefront, interfere with other people&apos;s orders, or post content
        that is unlawful, abusive or misleading. We may suspend accounts that do.
      </p>

      <h2>10. Liability</h2>
      <p>
        Roam and the Association do not prepare food and are not responsible for its quality, safety
        or allergen information — that is the venue&apos;s responsibility; ask the venue about
        allergens before ordering. Nothing in these terms limits liability that cannot be limited by
        law. Otherwise, Roam&apos;s and the Association&apos;s liability to you in connection with the
        storefront is limited to the amount you paid for the order concerned.
      </p>

      <h2>11. Changes to these terms</h2>
      <p>
        We may update these terms; the date at the top shows the current version. Material changes
        are announced on the storefront before they take effect.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions about an order: contact the venue. Questions about the storefront, these terms or
        your account: contact Roam through the support details on your account page.
      </p>
    </LegalDoc>
  );
}

function RoamTerms() {
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
