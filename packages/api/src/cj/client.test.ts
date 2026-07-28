import { describe, it, expect } from "vitest";
import { parseLinks, normalizeLink, isPromotional } from "./client.js";

/**
 * Unit tests for the PURE CJ Link Search helpers: the defensive XML/JSON parser, the raw→CjDeal
 * mapper (reads fields from several plausible names, drops structurally-incomplete links), and the
 * promotional-signal gate. The HTTP paging itself is I/O and isn't unit-tested (same posture as the
 * Awin client, whose normaliser is the tested surface).
 */

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <links total-matched="2" records-returned="2" page-number="1">
    <link>
      <advertiser-id>1001</advertiser-id>
      <advertiser-name>ASOS</advertiser-name>
      <link-id>555</link-id>
      <link-name>20% off everything</link-name>
      <link-type>Text Link</link-type>
      <clickUrl>https://www.anrdoezrs.net/click-1234-555</clickUrl>
      <description>Spend &amp;pound;50, save 20%.</description>
      <coupon-code>SAVE20</coupon-code>
      <promotion-type>Coupon</promotion-type>
      <promotion-start-date>2026-07-01T00:00:00Z</promotion-start-date>
      <promotion-end-date>2026-07-31T00:00:00Z</promotion-end-date>
      <category>Fashion</category>
    </link>
    <link>
      <advertiser-id>2002</advertiser-id>
      <advertiser-name>Generic Store</advertiser-name>
      <link-id>777</link-id>
      <link-name>Homepage</link-name>
      <link-type>Text Link</link-type>
      <clickUrl>https://www.tkqlhce.com/click-1234-777</clickUrl>
    </link>
  </links>
</cj-api>`;

describe("parseLinks", () => {
  it("extracts each <link> element's child tags from XML", () => {
    const rows = parseLinks(XML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      "advertiser-id": "1001",
      "link-id": "555",
      "link-name": "20% off everything",
      "coupon-code": "SAVE20",
      "promotion-type": "Coupon",
    });
    // XML entities are decoded.
    expect(rows[0]!["description"]).toBe("Spend &pound;50, save 20%.");
  });

  it("also accepts a JSON body ({ links: [...] })", () => {
    const rows = parseLinks(JSON.stringify({ links: [{ "link-id": "9", "advertiser-id": "8", "link-name": "X", clickUrl: "https://x.test" }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "link-id": "9", clickUrl: "https://x.test" });
  });

  it("degrades to [] on an unparseable / empty body", () => {
    expect(parseLinks("")).toEqual([]);
    expect(parseLinks("<html>error</html>")).toEqual([]);
    expect(parseLinks("{not json")).toEqual([]);
  });
});

describe("normalizeLink", () => {
  it("maps a coupon link and detects kind='voucher' from the coupon code", () => {
    const [coupon] = parseLinks(XML);
    const deal = normalizeLink(coupon!);
    expect(deal).not.toBeNull();
    expect(deal).toMatchObject({
      linkId: "555",
      advertiserId: "1001",
      advertiserName: "ASOS",
      title: "20% off everything",
      kind: "voucher",
      voucherCode: "SAVE20",
      destinationUrl: "https://www.anrdoezrs.net/click-1234-555",
      category: "Fashion",
      startsAt: "2026-07-01T00:00:00Z",
      endsAt: "2026-07-31T00:00:00Z",
    });
  });

  it("maps a plain link as kind='offer' when there's no coupon", () => {
    const deal = normalizeLink({ "link-id": "3", "advertiser-id": "4", "link-name": "Sale", clickUrl: "https://x.test/s", "promotion-type": "Sale" });
    expect(deal).toMatchObject({ linkId: "3", kind: "offer", voucherCode: null, destinationUrl: "https://x.test/s" });
  });

  it("returns null when a structural essential is missing", () => {
    expect(normalizeLink({ "advertiser-id": "1", "link-name": "x", clickUrl: "https://x.test" })).toBeNull(); // no link-id
    expect(normalizeLink({ "link-id": "1", "link-name": "x", clickUrl: "https://x.test" })).toBeNull(); // no advertiser-id
    expect(normalizeLink({ "link-id": "1", "advertiser-id": "2", "link-name": "x" })).toBeNull(); // no clickUrl
  });
});

describe("isPromotional", () => {
  it("true when a coupon, promotion type, or end date is present", () => {
    expect(isPromotional({ "coupon-code": "X" })).toBe(true);
    expect(isPromotional({ "promotion-type": "Sale" })).toBe(true);
    expect(isPromotional({ "promotion-end-date": "2026-07-31" })).toBe(true);
  });
  it("false for a generic link with no promotional signal", () => {
    const [, generic] = parseLinks(XML);
    expect(isPromotional(generic!)).toBe(false);
  });
});
