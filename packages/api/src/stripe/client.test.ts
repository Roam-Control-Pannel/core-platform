import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { encodeForm, verifyStripeSignature } from "./client.js";

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
