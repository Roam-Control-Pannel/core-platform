import { describe, it, expect } from "vitest";
import { parseAdvertisers, normalizeAdvertiser } from "./advertisers.js";

/**
 * Unit tests for the PURE CJ Advertiser Lookup helpers: the defensive XML/JSON parser and the
 * raw→CjAdvertiser mapper (reads the logo from several plausible field names, tolerates its absence).
 * The HTTP paging is I/O and isn't unit-tested (same posture as the Link Search client). These tests
 * pin the behaviour the deals surface depends on: an advertiser with no logo yields logoUrl=null
 * (→ the card keeps its category-icon fallback), never a throw.
 */

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <advertisers total-matched="2" records-returned="2" page-number="1">
    <advertiser>
      <advertiser-id>1001</advertiser-id>
      <advertiser-name>ASOS &amp; Co</advertiser-name>
      <account-status>Active</account-status>
      <logo-url>https://logos.cj.com/1001.png</logo-url>
    </advertiser>
    <advertiser>
      <advertiser-id>2002</advertiser-id>
      <advertiser-name>No Logo Ltd</advertiser-name>
      <account-status>Active</account-status>
    </advertiser>
  </advertisers>
</cj-api>`;

describe("parseAdvertisers", () => {
  it("extracts each <advertiser> element's flat fields from XML", () => {
    const rows = parseAdvertisers(XML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      "advertiser-id": "1001",
      "advertiser-name": "ASOS & Co", // XML entity decoded
      "logo-url": "https://logos.cj.com/1001.png",
    });
    expect(rows[1]).toMatchObject({ "advertiser-id": "2002", "advertiser-name": "No Logo Ltd" });
    expect(rows[1]!["logo-url"]).toBeUndefined();
  });

  it("also accepts a JSON body ({ advertisers: [...] })", () => {
    const rows = parseAdvertisers(
      JSON.stringify({ advertisers: [{ "advertiser-id": "9", "advertiser-name": "X", "logo-url": "https://x.test/l.png" }] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "advertiser-id": "9", "logo-url": "https://x.test/l.png" });
  });

  it("degrades to [] on an unparseable / empty body", () => {
    expect(parseAdvertisers("")).toEqual([]);
    expect(parseAdvertisers("<html>error</html>")).toEqual([]);
    expect(parseAdvertisers("{not json")).toEqual([]);
  });
});

describe("normalizeAdvertiser", () => {
  it("maps an advertiser with a logo", () => {
    const [asos] = parseAdvertisers(XML);
    expect(normalizeAdvertiser(asos!)).toEqual({
      advertiserId: "1001",
      advertiserName: "ASOS & Co",
      logoUrl: "https://logos.cj.com/1001.png",
    });
  });

  it("yields logoUrl=null when the advertiser exposes no logo", () => {
    const [, noLogo] = parseAdvertisers(XML);
    expect(normalizeAdvertiser(noLogo!)).toEqual({
      advertiserId: "2002",
      advertiserName: "No Logo Ltd",
      logoUrl: null,
    });
  });

  it("reads the logo from any of several plausible field names", () => {
    for (const key of ["logo", "advertiser-logo-url", "program-logo-url", "image-url"]) {
      const adv = normalizeAdvertiser({ "advertiser-id": "7", [key]: "https://x.test/logo.png" });
      expect(adv?.logoUrl).toBe("https://x.test/logo.png");
    }
  });

  it("ignores a non-http logo value (guards against junk / relative paths)", () => {
    expect(normalizeAdvertiser({ "advertiser-id": "7", "logo-url": "not-a-url" })?.logoUrl).toBeNull();
  });

  it("returns null when there's no advertiser id (nothing to key on)", () => {
    expect(normalizeAdvertiser({ "advertiser-name": "Orphan", "logo-url": "https://x.test/l.png" })).toBeNull();
  });
});
