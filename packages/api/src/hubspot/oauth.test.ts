import { describe, it, expect } from "vitest";
import { signState, verifyState, authorizeUrl, HUBSPOT_SCOPES, type HubspotAppConfig } from "./oauth.js";
import { hubspot } from "@roam/core";

const APP: HubspotAppConfig = {
  baseUrl: "https://api.hubapi.test",
  appUrl: "https://app.hubspot.test",
  clientId: "client-test",
  clientSecret: "secret-test",
  redirectUri: "https://api.roam.test/integrations/hubspot/callback",
  stateSecret: "state-secret",
  propertyMap: hubspot.DEFAULT_PROPERTY_MAP,
  pageSize: 100,
  maxPages: 10,
};

/**
 * `state` is the WHOLE authorisation on the callback. One HubSpot app serves every whitelabel, so
 * every partner returns to the same public redirect URI carrying no Roam credentials — the only
 * thing saying which channel is connecting is this parameter. Forge it and you could bind your own
 * HubSpot portal to someone else's channel, so these are security tests, not plumbing tests.
 */
describe("OAuth state", () => {
  it("round-trips the channel it was issued for", () => {
    const state = signState("f2g", "state-secret");
    expect(verifyState(state, "state-secret")).toBe("f2g");
  });

  it("rejects a state signed with a different secret", () => {
    const state = signState("f2g", "someone-elses-secret");
    expect(verifyState(state, "state-secret")).toBeNull();
  });

  it("rejects a state whose channel has been swapped after signing", () => {
    const state = signState("f2g", "state-secret");
    const tampered = state.replace(/^f2g\./, "other-partner.");
    expect(verifyState(tampered, "state-secret")).toBeNull();
  });

  it("rejects an expired state", () => {
    const state = signState("f2g", "state-secret", 1000, 1_000_000);
    expect(verifyState(state, "state-secret", 1_000_000 + 500)).toBe("f2g"); // still inside the window
    expect(verifyState(state, "state-secret", 1_000_000 + 5000)).toBeNull(); // past it
  });

  it("rejects malformed, empty and missing states, and an unset secret", () => {
    for (const bad of ["", "nonsense", "a.b.c", "a.b.c.d.e", null, undefined]) {
      expect(verifyState(bad, "state-secret")).toBeNull();
    }
    expect(verifyState(signState("f2g", "state-secret"), "")).toBeNull();
  });

  it("issues a different state each time, so one cannot be recognised and replayed by shape", () => {
    expect(signState("f2g", "state-secret")).not.toBe(signState("f2g", "state-secret"));
  });
});

describe("authorizeUrl", () => {
  it("asks only for read scopes, and carries the signed channel", () => {
    const url = new URL(authorizeUrl(APP, "f2g"));
    expect(url.origin + url.pathname).toBe("https://app.hubspot.test/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-test");
    expect(url.searchParams.get("redirect_uri")).toBe(APP.redirectUri);
    expect(url.searchParams.get("scope")).toBe(HUBSPOT_SCOPES.join(" "));
    expect(verifyState(url.searchParams.get("state"), APP.stateSecret)).toBe("f2g");
  });

  it("requests nothing that can write to a partner's CRM", () => {
    for (const scope of HUBSPOT_SCOPES) expect(scope.endsWith(".read")).toBe(true);
  });

  it("never puts the client secret in a browser-facing URL", () => {
    expect(authorizeUrl(APP, "f2g")).not.toContain(APP.clientSecret);
  });
});
