/**
 * Community Guidelines. Placeholder skeleton — replace the body with the final copy and remove the
 * `draft` flag on <LegalDoc>. The section headings below are a suggested skeleton only.
 */
import type { Metadata } from "next";
import { LegalDoc } from "../../../components/LegalDoc";

export const metadata: Metadata = { title: "Community Guidelines" };

export default function GuidelinesPage() {
  return (
    <LegalDoc title="Community Guidelines" draft>
      <p>
        <strong>Placeholder.</strong> Replace this page&apos;s content with the final Community
        Guidelines. The structure below is only a starting skeleton.
      </p>
      <h2>Be kind and local</h2>
      <p>Roam is a hyper-local community — treat neighbours and businesses with respect.</p>
      <h2>What&apos;s not allowed</h2>
      <p>Harassment, hate, spam, illegal content, and impersonation.</p>
      <h2>Reviews and posts</h2>
      <p>Keep contributions honest, first-hand, and relevant to the place.</p>
      <h2>Reporting and enforcement</h2>
      <p>How to report content and what happens when guidelines are broken.</p>
    </LegalDoc>
  );
}
