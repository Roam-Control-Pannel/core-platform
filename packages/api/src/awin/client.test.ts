import { describe, it, expect } from "vitest";
import { normalizeOffer } from "./client.js";

describe("normalizeOffer", () => {
  it("maps a voucher offer and detects kind from a voucher code", () => {
    const o = normalizeOffer({
      promotionId: "12345",
      advertiser: { id: 678, name: "ASOS" },
      title: "20% off everything",
      description: "Spend £50, save 20%.",
      type: "voucher",
      voucher: { code: "SAVE20" },
      terms: "New customers only.",
      urlClickThrough: "https://www.asos.com/sale",
      startDate: "2026-07-01T00:00:00Z",
      endDate: "2026-07-31T00:00:00Z",
    });
    expect(o).not.toBeNull();
    expect(o).toMatchObject({
      promotionId: "12345",
      advertiserId: "678",
      advertiserName: "ASOS",
      kind: "voucher",
      voucherCode: "SAVE20",
      destinationUrl: "https://www.asos.com/sale",
      startsAt: "2026-07-01T00:00:00Z",
      endsAt: "2026-07-31T00:00:00Z",
    });
  });

  it("treats a code-less promotion as an 'offer'", () => {
    const o = normalizeOffer({
      id: "9",
      advertiserId: "42",
      advertiserName: "Booking.com",
      title: "Free cancellation",
      url: "https://www.booking.com/deals",
    });
    expect(o?.kind).toBe("offer");
    expect(o?.advertiserId).toBe("42");
    expect(o?.destinationUrl).toBe("https://www.booking.com/deals");
  });

  it("drops an offer missing an id, advertiser, title, or destination", () => {
    expect(normalizeOffer({ title: "No id or advertiser", url: "https://x.com" })).toBeNull();
    expect(normalizeOffer({ promotionId: "1", advertiser: { id: "2" }, title: "No url" })).toBeNull();
    expect(normalizeOffer({ promotionId: "1", title: "No advertiser", url: "https://x.com" })).toBeNull();
  });

  it("falls back through alternative field names", () => {
    const o = normalizeOffer({
      promotionID: "77",
      programme: { id: "5", name: "Nike" },
      name: "Members get 25% off",
      promotionType: "code",
      code: "MEMBER25",
      landingPage: "https://www.nike.com/member",
      validTo: "2026-08-01T00:00:00Z",
    });
    expect(o).toMatchObject({ promotionId: "77", advertiserId: "5", advertiserName: "Nike", kind: "voucher", voucherCode: "MEMBER25", endsAt: "2026-08-01T00:00:00Z" });
  });
});
