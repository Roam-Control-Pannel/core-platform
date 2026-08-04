import { describe, it, expect } from "vitest";
import { parseAdvertisers, normalizeAdvertiser, domainFromUrl } from "./advertisers.js";

/**
 * Unit tests for the PURE CJ Advertiser Lookup helpers: the defensive XML/JSON parser and the
 * raw→CjAdvertiser mapper. CJ's Advertiser Lookup carries NO logo field, but it returns each
 * advertiser's own site (program-url), from which we derive a brand logo via its domain. These tests
 * pin that: a real program-url yields a logo; a missing one yields logoUrl=null (→ the card keeps its
 * category-icon fallback), never a throw. The HTTP paging is I/O and isn't unit-tested.
 */

// Mirrors a real CJ Advertiser Lookup response: program-url present, no logo field anywhere.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <advertisers total-matched="2" records-returned="2" page-number="1">
    <advertiser>
      <advertiser-id>965192</advertiser-id>
      <account-status>Active</account-status>
      <advertiser-name>CruiseDirect &amp; Co</advertiser-name>
      <program-url>http://www.cruisedirect.com</program-url>
      <relationship-status>joined</relationship-status>
    </advertiser>
    <advertiser>
      <advertiser-id>2002</advertiser-id>
      <account-status>Active</account-status>
      <advertiser-name>No Site Ltd</advertiser-name>
    </advertiser>
  </advertisers>
</cj-api>`;

describe("parseAdvertisers", () => {
  it("extracts each <advertiser> element's flat fields from XML", () => {
    const rows = parseAdvertisers(XML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      "advertiser-id": "965192",
      "advertiser-name": "CruiseDirect & Co", // XML entity decoded
      "program-url": "http://www.cruisedirect.com",
    });
    expect(rows[1]).toMatchObject({ "advertiser-id": "2002", "advertiser-name": "No Site Ltd" });
    expect(rows[1]!["program-url"]).toBeUndefined();
  });

  it("also accepts a JSON body ({ advertisers: [...] })", () => {
    const rows = parseAdvertisers(
      JSON.stringify({ advertisers: [{ "advertiser-id": "9", "advertiser-name": "X", "program-url": "https://x.test" }] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "advertiser-id": "9", "program-url": "https://x.test" });
  });

  it("degrades to [] on an unparseable / empty body", () => {
    expect(parseAdvertisers("")).toEqual([]);
    expect(parseAdvertisers("<html>error</html>")).toEqual([]);
    expect(parseAdvertisers("{not json")).toEqual([]);
  });
});

describe("domainFromUrl", () => {
  it("reduces a program URL to a bare domain", () => {
    expect(domainFromUrl("http://www.CruiseDirect.com/deals")).toBe("cruisedirect.com");
    expect(domainFromUrl("https://priceline.com")).toBe("priceline.com");
    expect(domainFromUrl("http://shop.example.co.uk/path?x=1")).toBe("shop.example.co.uk");
    expect(domainFromUrl("https://user:pass@brand.com:8443/")).toBe("brand.com");
  });

  it("returns null for junk / non-hosts", () => {
    expect(domainFromUrl(null)).toBeNull();
    expect(domainFromUrl("")).toBeNull();
    expect(domainFromUrl("not a url")).toBeNull();
    expect(domainFromUrl("localhost")).toBeNull(); // no TLD
  });
});

describe("normalizeAdvertiser", () => {
  it("derives a brand logo from the program-url domain", () => {
    const [cruise] = parseAdvertisers(XML);
    expect(normalizeAdvertiser(cruise!)).toEqual({
      advertiserId: "965192",
      advertiserName: "CruiseDirect & Co",
      programUrl: "http://www.cruisedirect.com",
      logoUrl: "https://logo.clearbit.com/cruisedirect.com",
    });
  });

  it("yields logoUrl=null when there's no usable site", () => {
    const [, noSite] = parseAdvertisers(XML);
    expect(normalizeAdvertiser(noSite!)).toEqual({
      advertiserId: "2002",
      advertiserName: "No Site Ltd",
      programUrl: null,
      logoUrl: null,
    });
  });

  it("prefers an explicit logo field if CJ ever provides one", () => {
    const adv = normalizeAdvertiser({
      "advertiser-id": "7",
      "program-url": "https://brand.com",
      "logo-url": "https://cdn.cj.com/7.png",
    });
    expect(adv?.logoUrl).toBe("https://cdn.cj.com/7.png");
  });

  it("returns null when there's no advertiser id (nothing to key on)", () => {
    expect(normalizeAdvertiser({ "advertiser-name": "Orphan", "program-url": "https://x.test" })).toBeNull();
  });
});
