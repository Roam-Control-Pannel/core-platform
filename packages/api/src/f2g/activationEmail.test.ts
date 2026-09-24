import { describe, it, expect } from "vitest";
import { renderActivationEmail, channelSender } from "./activationEmail.js";

const BASE = { email: "no-reply@roam.example", name: "Roam" };

describe("channelSender", () => {
  it("uses the partner's own org name, so their mail says them and not Roam", () => {
    expect(channelSender(BASE, { name: "Food to Go", orgName: "NI Food to Go Association" })).toEqual({
      email: "no-reply@roam.example",
      name: "NI Food to Go Association",
    });
  });

  it("falls back to the channel name when there is no separate org name", () => {
    expect(channelSender(BASE, { name: "Food to Go", orgName: null }).name).toBe("Food to Go");
  });

  it("falls back to Roam's own sender rather than leaving an empty From", () => {
    expect(channelSender(BASE, null)).toEqual(BASE);
    expect(channelSender(BASE, { name: "   ", orgName: "  " })).toEqual(BASE);
  });

  it("NEVER changes the from-address — that needs domain verification we have not done", () => {
    // Sending from an unverified partner domain is the fastest way to land the one email that
    // matters in a spam folder. The name is the partner's; the address stays Roam's.
    expect(channelSender(BASE, { name: "Food to Go", orgName: "NIF2G" }).email).toBe(BASE.email);
  });
});

describe("renderActivationEmail", () => {
  const args = {
    sourceName: "Bob & Sons <Cafe>",
    code: "084219",
    expiresInMinutes: 15,
    channelName: "NI Food to Go",
  };

  it("puts the code in the subject, so it is readable from a notification", () => {
    expect(renderActivationEmail(args).subject).toContain("084219");
  });

  it("carries the code and its expiry in both parts", () => {
    const { html, text } = renderActivationEmail(args);
    expect(html).toContain("084219");
    expect(text).toContain("084219");
    expect(html).toContain("15");
    expect(text).toContain("15 minutes");
  });

  it("escapes the business name — it comes from a partner's CRM, not from us", () => {
    const { html } = renderActivationEmail(args);
    expect(html).toContain("Bob &amp; Sons &lt;Cafe&gt;");
    expect(html).not.toContain("Bob & Sons <Cafe>");
  });

  it("tells an unexpecting recipient they can ignore it", () => {
    const { text } = renderActivationEmail(args);
    expect(text.toLowerCase()).toContain("ignore");
  });

  it("falls back to a friendly greeting when the roster name is blank", () => {
    expect(renderActivationEmail({ ...args, sourceName: "   " }).text).toContain("Hi there,");
  });
});
