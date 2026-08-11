import { describe, it, expect } from "vitest";
import { makeOriginAllowed } from "./cors.js";

describe("makeOriginAllowed", () => {
  it("matches exact entries verbatim (the common web/console/admin origins)", () => {
    const allowed = makeOriginAllowed(["http://localhost:3000", "https://app.roam-everywhere.com"]);
    expect(allowed("http://localhost:3000")).toBe(true);
    expect(allowed("https://app.roam-everywhere.com")).toBe(true);
    expect(allowed("http://localhost:3001")).toBe(false);
    expect(allowed("https://evil.com")).toBe(false);
  });

  it("clears every co-brand subdomain via a single wildcard entry", () => {
    const allowed = makeOriginAllowed(["https://*.roam-local.com"]);
    expect(allowed("https://nifood2go.roam-local.com")).toBe(true); // the reported storefront host
    expect(allowed("https://food.roam-local.com")).toBe(true);
    expect(allowed("https://staging.nifood2go.roam-local.com")).toBe(true); // nested labels ok
  });

  it("never lets a look-alike suffix satisfy a wildcard (anchored match)", () => {
    const allowed = makeOriginAllowed(["https://*.roam-local.com"]);
    expect(allowed("https://roam-local.com.evil.com")).toBe(false);
    expect(allowed("https://nifood2go.roam-local.com.evil.com")).toBe(false);
    expect(allowed("http://nifood2go.roam-local.com")).toBe(false); // scheme is part of the entry
    expect(allowed("https://roam-local.com")).toBe(false); // apex needs its own exact entry
  });

  it("honours the wildcard scheme — an https entry does not admit http", () => {
    const allowed = makeOriginAllowed(["https://*.roam-everywhere.com"]);
    expect(allowed("https://x.roam-everywhere.com")).toBe(true);
    expect(allowed("http://x.roam-everywhere.com")).toBe(false);
  });

  it("supports a mixed list of exact and wildcard entries", () => {
    const allowed = makeOriginAllowed(["http://localhost:3000", "https://*.roam-local.com"]);
    expect(allowed("http://localhost:3000")).toBe(true);
    expect(allowed("https://cafe.roam-local.com")).toBe(true);
    expect(allowed("https://other.com")).toBe(false);
  });
});
