import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { encodeForm, verifyStripeSignature, createCartCheckoutSession } from "./client.js";

/** Run a body-capturing fake fetch for one Stripe call, returning the decoded form body. */
async function captureStripeBody(run: () => Promise<unknown>): Promise<string> {
  let body = "";
  const orig = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (_url: any, init: any) => {
    body = decodeURIComponent(String(init?.body ?? ""));
    return { ok: true, json: async () => ({ id: "cs_1", url: "https://pay.test/s" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
  }
  return body;
}

describe("createCartCheckoutSession", () => {
  it("builds multiple product lines plus a delivery line, commission on goods only", async () => {
    const body = await captureStripeBody(() =>
      createCartCheckoutSession({ secretKey: "sk_test" }, {
        destinationAccount: "acct_1",
        applicationFeePence: 68, // 5% of £13.50 goods — NOT of goods + delivery
        currency: "gbp",
        lines: [
          { title: "Sausage roll", unitAmountPence: 500, quantity: 2 },
          { title: "Tea", unitAmountPence: 350, quantity: 1 },
        ],
        deliveryFeePence: 250,
        deliveryLabel: "Delivery",
        orderId: "o_1",
        successUrl: "https://x.test/ok",
        cancelUrl: "https://x.test/no",
      }),
    );
    expect(body).toContain("line_items[0][quantity]=2");
    expect(body).toContain("line_items[0][price_data][unit_amount]=500");
    expect(body).toContain("line_items[1][price_data][unit_amount]=350");
    // The delivery fee is its own line (routes to the vendor in full).
    expect(body).toContain("line_items[2][price_data][unit_amount]=250");
    expect(body).toContain("line_items[2][price_data][product_data][name]=Delivery");
    // Application fee (platform commission) is on goods only.
    expect(body).toContain("payment_intent_data[application_fee_amount]=68");
    expect(body).toContain("payment_intent_data[transfer_data][destination]=acct_1");
    expect(body).toContain("metadata[order_id]=o_1");
  });

  it("omits the delivery line when the fee is zero (collection / free delivery)", async () => {
    const body = await captureStripeBody(() =>
      createCartCheckoutSession({ secretKey: "sk_test" }, {
        destinationAccount: "acct_1",
        applicationFeePence: 40,
        currency: "gbp",
        lines: [{ title: "Tea", unitAmountPence: 800, quantity: 1 }],
        deliveryFeePence: 0,
        orderId: "o_2",
        successUrl: "https://x.test/ok",
        cancelUrl: "https://x.test/no",
      }),
    );
    expect(body).toContain("line_items[0][price_data][unit_amount]=800");
    expect(body).not.toContain("line_items[1]");
  });
});

describe("encodeForm", () => {
  it("encodes flat params", () => {
    expect(encodeForm({ type: "express", country: "GB" })).toBe("type=express&country=GB");
  });

  it("encodes nested objects with bracket notation", () => {
    expect(encodeForm({ capabilities: { transfers: { requested: true } } })).toBe(
      "capabilities%5Btransfers%5D%5Brequested%5D=true",
    );
  });

  it("encodes arrays with indexed brackets", () => {
    expect(encodeForm({ items: [{ price: "p_1" }, { price: "p_2" }] })).toBe(
      "items%5B0%5D%5Bprice%5D=p_1&items%5B1%5D%5Bprice%5D=p_2",
    );
  });

  it("omits null and undefined values", () => {
    expect(encodeForm({ a: 1, b: null, c: undefined })).toBe("a=1");
  });

  it("URL-encodes values", () => {
    expect(encodeForm({ return_url: "https://x.test/a?b=1&c=2" })).toBe(
      "return_url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1%26c%3D2",
    );
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "account.updated" });

  function sign(ts: number, payload: string, key = secret): string {
    const mac = createHmac("sha256", key).update(`${ts}.${payload}`).digest("hex");
    return `t=${ts},v1=${mac}`;
  }

  it("accepts a valid signature within tolerance", () => {
    const ts = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(ts, body), secret, ts * 1000)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = 1_700_000_000;
    expect(verifyStripeSignature(body + "x", sign(ts, body), secret, ts * 1000)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const ts = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(ts, body, "whsec_other"), secret, ts * 1000)).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    const ts = 1_700_000_000;
    const tenMinutesLater = (ts + 600) * 1000;
    expect(verifyStripeSignature(body, sign(ts, body), secret, tenMinutesLater)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyStripeSignature(body, null, secret, Date.now())).toBe(false);
    expect(verifyStripeSignature(body, "v1=deadbeef", secret, Date.now())).toBe(false);
    expect(verifyStripeSignature(body, "t=notanumber,v1=deadbeef", secret, Date.now())).toBe(false);
  });

  it("accepts when any one of multiple v1 candidates matches (key rotation)", () => {
    const ts = 1_700_000_000;
    const good = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const header = `t=${ts},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifyStripeSignature(body, header, secret, ts * 1000)).toBe(true);
  });
});
