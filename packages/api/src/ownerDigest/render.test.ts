import { describe, it, expect } from "vitest";
import { renderOwnerDigestEmail } from "./render.js";

describe("renderOwnerDigestEmail", () => {
  const base = {
    dashboardUrl: "https://app.roam-local.com/dashboard",
    unsubscribeUrl: "https://app.roam-local.com/unsubscribe/owner-digest?token=abc.def",
    items: [
      { text: "New review on The Blue Bell", url: "https://app.roam-local.com/venue/the-blue-bell" },
      { text: "New order — 2× Flat white", url: "https://app.roam-local.com/dashboard" },
    ],
  };

  it("pluralises the subject by item count", () => {
    expect(renderOwnerDigestEmail({ ...base, items: base.items.slice(0, 1) }).subject).toBe("1 new update on your Roam business");
    expect(renderOwnerDigestEmail(base).subject).toBe("2 new updates on your Roam business");
  });

  it("embeds every item's text, the dashboard CTA and the unsubscribe link", () => {
    const { html, text } = renderOwnerDigestEmail(base);
    expect(html).toContain("New review on The Blue Bell");
    expect(html).toContain("New order — 2× Flat white");
    expect(html).toContain(base.dashboardUrl);
    expect(html).toContain(base.unsubscribeUrl);
    expect(text).toContain("Unsubscribe: " + base.unsubscribeUrl);
  });

  it("escapes HTML in item text (no injection via a venue name)", () => {
    const { html } = renderOwnerDigestEmail({ ...base, items: [{ text: 'Review on <script>"Bad"</script>', url: null }] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("greets by first name when provided", () => {
    expect(renderOwnerDigestEmail({ ...base, ownerFirstName: "Andy" }).html).toContain("Hi Andy,");
    expect(renderOwnerDigestEmail(base).html).toContain("Hi,");
  });
});
