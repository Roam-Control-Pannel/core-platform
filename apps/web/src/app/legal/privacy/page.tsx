/**
 * Privacy Policy.
 *
 * Channel-aware (holistic plan Phase 1.3): a branded storefront host (the NI Food to Go
 * Association) gets the STOREFRONT policy — who the controller is for shopper accounts and orders,
 * how the Association's membership roster is handled, what venues, Stripe, Brevo and Google
 * receive, the consent-gated analytics, and the rights people have. Roam's own policy remains the
 * original placeholder skeleton until its final copy is written.
 *
 * Known blanks for the review pass: Roam's registered company details, the Association's, and the
 * data-processing agreement reference (plan Phase 0 item 6 / Phase 5.3).
 */
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";
import { getChannelInfo } from "../../../lib/serverApi";

export const metadata: Metadata = { title: "Privacy Policy" };

export default async function PrivacyPage() {
  const channel = await getChannelInfo();
  if (channel && !channel.isDefault) return <StorefrontPrivacy brand={channel.name} />;
  return <RoamPrivacy />;
}

function StorefrontPrivacy({ brand }: { brand: string }) {
  return (
    <LegalDoc
      title="Privacy Policy"
      lastUpdated="17 September 2026"
      draft
      draftNote={`Working version — prepared for review by Roam and the ${brand} Association. It applies as written until a revised version replaces it.`}
      backHref="/"
      backLabel={brand}
    >
      <h2>1. Who is responsible for your data</h2>
      <p>
        <strong>Roam</strong> operates this storefront and is the data controller for your account,
        your orders and your use of the site. The <strong>{brand} Association</strong> supplies its
        membership roster (business names, addresses, contact details and membership numbers) so
        that member businesses can be recognised; the Association remains responsible for that
        roster and Roam processes it on the Association&apos;s behalf, only to run the membership
        features described here.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li>
          <strong>Account:</strong> your e-mail address, display name and sign-in details.
        </li>
        <li>
          <strong>Orders:</strong> what you ordered, from which venue, the amount, the collection code
          and, for delivery, the address you give us.
        </li>
        <li>
          <strong>Location:</strong> the town you choose on the storefront, or your device location if
          you allow it, to show venues near you.
        </li>
        <li>
          <strong>Usage:</strong> pages viewed and actions taken, only if you accept analytics (see
          section 5).
        </li>
        <li>
          <strong>Business users:</strong> if you activate a venue, the details you enter about the
          business and, for Association members, your membership number.
        </li>
      </ul>

      <h2>3. How we use it</h2>
      <p>
        To take and fulfil orders, to show you nearby venues, to run your account, to recognise
        Association members, to keep the site safe (fraud and abuse prevention, moderation) and to
        tell you about your orders. We rely on our contract with you, our legitimate interest in
        running a safe service, and your consent where the law requires it (analytics cookies).
      </p>

      <h2>4. Who receives it</h2>
      <ul>
        <li>
          <strong>The venue</strong> you order from receives your name, your order, your collection
          code and, for delivery, your address and contact details — it needs them to prepare and
          hand over your order.
        </li>
        <li>
          <strong>Stripe</strong> processes card payments; Roam never sees your full card number.
        </li>
        <li>
          <strong>Brevo</strong> sends transactional e-mail (for example order updates) on our behalf.
        </li>
        <li>
          <strong>Supabase</strong> hosts our database; <strong>Railway</strong> and our web host run
          the service.
        </li>
        <li>
          <strong>Google</strong> supplies some venue listings, photos and maps data, and — only if you
          accept analytics — Google Analytics receives usage data.
        </li>
        <li>
          The <strong>{brand} Association</strong> may see aggregate figures about the storefront
          (for example how many member businesses are active) and the status of its own roster. It
          does not receive your account or order details.
        </li>
        <li>Public authorities or advisers where the law requires.</li>
      </ul>

      <h2>5. Cookies and analytics</h2>
      <p>
        Essential cookies keep you signed in and remember choices such as your town and your cookie
        decision. Analytics cookies (Google Analytics) are set only after you choose &ldquo;Accept
        analytics&rdquo; in the cookie banner; choosing &ldquo;Essential only&rdquo; keeps the site
        working with no analytics at all. You can change your choice by clearing the site&apos;s
        cookies.
      </p>

      <h2>6. Food hygiene ratings</h2>
      <p>
        Ratings shown on venue pages are public information published by the Food Standards Agency
        under the Open Government Licence. They concern businesses, not individuals.
      </p>

      <h2>7. Your rights</h2>
      <p>
        You can access, correct, export or erase your personal data, object to or restrict certain
        processing, and complain to the Information Commissioner&apos;s Office. You can delete your
        account at any time from your account page; order records needed for accounting and dispute
        handling are kept for the period the law requires and then removed. Association members can
        also ask the Association to correct roster details.
      </p>

      <h2>8. Retention and security</h2>
      <p>
        Account data is kept while your account exists. Order and payment records are kept for up to
        six years for accounting and legal purposes. Roster data is kept while the business is on the
        Association&apos;s roster and for a short period after it lapses, then removed. Data is
        stored in the UK/EEA on encrypted infrastructure with access restricted to staff who need it.
      </p>

      <h2>9. Contact</h2>
      <p>
        For privacy questions or to exercise your rights, contact Roam through the support details on
        your account page. For questions about the Association&apos;s roster, contact the Association.
      </p>
    </LegalDoc>
  );
}

function RoamPrivacy() {
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
