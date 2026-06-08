import { describe, it, expect } from "vitest";
import {
  validateRegistration,
  parseWebToken,
  type SubscriptionRegistration,
  type WebPushToken,
} from "./index.js";

const webSub: WebPushToken = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "BNcKey", auth: "authsecret" },
};
const webToken = JSON.stringify(webSub);

const baseWeb: SubscriptionRegistration = {
  platform: "web",
  token: webToken,
};

describe("validateRegistration", () => {
  it("accepts a well-formed web subscription", () => {
    expect(validateRegistration(baseWeb).ok).toBe(true);
  });

  it("accepts a non-empty native token", () => {
    expect(
      validateRegistration({ platform: "ios", token: "apns-device-token" }).ok,
    ).toBe(true);
    expect(
      validateRegistration({ platform: "android", token: "fcm-reg-token" }).ok,
    ).toBe(true);
  });

  it("rejects an unknown platform", () => {
    const r = validateRegistration({
      platform: "windows" as SubscriptionRegistration["platform"],
      token: "x",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an empty or whitespace token", () => {
    expect(validateRegistration({ platform: "ios", token: "" }).ok).toBe(false);
    expect(validateRegistration({ platform: "ios", token: "   " }).ok).toBe(
      false,
    );
  });

  it("rejects a web token that is not valid JSON", () => {
    expect(validateRegistration({ platform: "web", token: "not-json" }).ok).toBe(
      false,
    );
  });

  it("rejects a web token missing the keys", () => {
    const r = validateRegistration({
      platform: "web",
      token: JSON.stringify({ endpoint: "https://example.com/x" }),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a web token with a non-https endpoint", () => {
    const r = validateRegistration({
      platform: "web",
      token: JSON.stringify({
        endpoint: "http://insecure.example.com/x",
        keys: { p256dh: "k", auth: "a" },
      }),
    });
    expect(r.ok).toBe(false);
  });

  it("does not apply web-token parsing to native platforms", () => {
    expect(
      validateRegistration({ platform: "android", token: "opaque-token" }).ok,
    ).toBe(true);
  });
});

describe("parseWebToken", () => {
  it("returns the typed token for a well-formed subscription", () => {
    expect(parseWebToken(webToken)).toEqual(webSub);
  });

  it("returns null for malformed JSON (never throws)", () => {
    expect(parseWebToken("{not json")).toBeNull();
  });

  it("returns null for a missing endpoint", () => {
    expect(
      parseWebToken(JSON.stringify({ keys: { p256dh: "k", auth: "a" } })),
    ).toBeNull();
  });

  it("returns null for a non-https endpoint", () => {
    expect(
      parseWebToken(
        JSON.stringify({
          endpoint: "http://x.example.com",
          keys: { p256dh: "k", auth: "a" },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when a key is empty", () => {
    expect(
      parseWebToken(
        JSON.stringify({
          endpoint: "https://x.example.com",
          keys: { p256dh: "", auth: "a" },
        }),
      ),
    ).toBeNull();
  });
});
