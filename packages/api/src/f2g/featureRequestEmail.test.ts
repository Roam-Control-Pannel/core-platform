import { describe, it, expect } from "vitest";
import { renderFeatureRequestUpdate } from "./featureRequestEmail.js";

/**
 * The title and notes in this e-mail are a partner's own free text, so escaping is a security
 * property, not a formatting one: a request titled `<script>` must read as that text in the
 * recipient's client rather than run in it.
 */
describe("renderFeatureRequestUpdate", () => {
  const base = {
    title: "Monthly order export",
    status: "planned",
    roamNotes: null,
    channelName: "NI Food to Go",
    portalUrl: "https://nifood2go.roam-local.com/association",
  };

  it("uses human wording rather than the database value", () => {
    expect(renderFeatureRequestUpdate(base).subject).toBe(
      "Your request has been planned: Monthly order export",
    );
    expect(renderFeatureRequestUpdate({ ...base, status: "shipped" }).subject).toContain("has shipped");
    expect(renderFeatureRequestUpdate({ ...base, status: "declined" }).subject).toContain("has been declined");
  });

  it("degrades honestly for a status it has no wording for", () => {
    const r = renderFeatureRequestUpdate({ ...base, status: "parked" });
    expect(r.subject).toContain("been moved to parked");
  });

  it("escapes a title that contains markup", () => {
    const r = renderFeatureRequestUpdate({ ...base, title: '<script>alert("x")</script>' });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    // The plain-text part is not markup, so it keeps the original characters.
    expect(r.text).toContain('<script>alert("x")</script>');
  });

  it("escapes Roam's notes and keeps their line breaks", () => {
    const r = renderFeatureRequestUpdate({ ...base, roamNotes: "Line one\n<b>Line two</b>" });
    expect(r.html).toContain("&lt;b&gt;Line two&lt;/b&gt;");
    expect(r.html).toContain("Line one<br>");
    expect(r.text).toContain("Line one\n<b>Line two</b>");
  });

  it("omits the notes block entirely when Roam left none", () => {
    const r = renderFeatureRequestUpdate(base);
    expect(r.html).not.toContain("From Roam");
    expect(r.text).not.toContain("From Roam");
  });

  it("escapes the portal URL it links to", () => {
    const r = renderFeatureRequestUpdate({ ...base, portalUrl: 'https://x.test/a"onmouseover="alert(1)' });
    expect(r.html).not.toContain('"onmouseover="');
    expect(r.html).toContain("&quot;onmouseover=&quot;");
  });
});
