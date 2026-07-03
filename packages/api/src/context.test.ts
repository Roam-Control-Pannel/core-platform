/**
 * Context unit tests — the pure, DB-free parts: bearer-token extraction and the
 * internal-call secret check. These are exactly the bits verifiable in-sandbox; the
 * DB-touching context behaviour is verified live, per the testing standard.
 */
import { describe, it, expect } from "vitest";
import { makeContextFactory, type ApiEnv, type HeaderBag } from "./context.js";

const env: ApiEnv = {
  supabase: { url: "https://example.supabase.co", anonKey: "anon-key" },
  supabaseServiceRoleKey: "service-key",
  internalCallSecret: "s3cr3t-internal-call",
  vapid: {
    subject: "mailto:test@example.com",
    publicKey: "test-public-key",
    privateKey: "test-private-key",
  },
  places: { apiKey: "test-places-key" },
  brevo: { apiKey: null, newUserListId: 93, businessListId: 3 },
  transit: { config: null },
  awin: { apiKey: null, publisherId: null, baseUrl: "https://api.awin.com", region: "GB", debug: false },
};

const createContext = makeContextFactory(env);

function headers(map: Record<string, string>): HeaderBag {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("access token extraction", () => {
  it("pulls the token out of a Bearer header", () => {
    const ctx = createContext({ headers: headers({ Authorization: "Bearer abc.def.ghi" }) });
    expect(ctx.accessToken).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the Bearer scheme and trims", () => {
    const ctx = createContext({ headers: headers({ authorization: "bearer   xyz  " }) });
    expect(ctx.accessToken).toBe("xyz");
  });

  it("is null when no Authorization header is present (anonymous browsing)", () => {
    const ctx = createContext({ headers: headers({}) });
    expect(ctx.accessToken).toBeNull();
  });

  it("is null for a malformed Authorization header", () => {
    const ctx = createContext({ headers: headers({ Authorization: "Token abc" }) });
    expect(ctx.accessToken).toBeNull();
  });
});

describe("internal-call detection", () => {
  it("is true for the exact secret", () => {
    const ctx = createContext({ headers: headers({ "x-internal-call": env.internalCallSecret }) });
    expect(ctx.isInternalCall).toBe(true);
  });

  it("is false for a wrong secret of equal length", () => {
    const wrong = "x".repeat(env.internalCallSecret.length);
    const ctx = createContext({ headers: headers({ "x-internal-call": wrong }) });
    expect(ctx.isInternalCall).toBe(false);
  });

  it("is false for a wrong-length secret", () => {
    const ctx = createContext({ headers: headers({ "x-internal-call": "short" }) });
    expect(ctx.isInternalCall).toBe(false);
  });

  it("is false when the header is absent", () => {
    const ctx = createContext({ headers: headers({}) });
    expect(ctx.isInternalCall).toBe(false);
  });
});

describe("forwarded client key", () => {
  it("is honoured ONLY on a trusted internal call", () => {
    const ctx = createContext({
      headers: headers({
        "x-internal-call": env.internalCallSecret,
        "x-roam-client-ip": "203.0.113.7",
      }),
    });
    expect(ctx.clientKey).toBe("203.0.113.7");
  });

  it("is ignored (null) when the call is not internal — no spoofing the rate bucket", () => {
    const ctx = createContext({ headers: headers({ "x-roam-client-ip": "203.0.113.7" }) });
    expect(ctx.clientKey).toBeNull();
  });

  it("is null on an internal call that forwards no client ip (e.g. local dev)", () => {
    const ctx = createContext({ headers: headers({ "x-internal-call": env.internalCallSecret }) });
    expect(ctx.clientKey).toBeNull();
  });
});

describe("context shape", () => {
  it("always carries a db client and the env", () => {
    const ctx = createContext({ headers: headers({}) });
    expect(ctx.db).toBeDefined();
    expect(ctx.env).toBe(env);
  });
});
