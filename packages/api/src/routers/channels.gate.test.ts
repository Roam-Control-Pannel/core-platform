import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { channelGatedOff } from "./channels.js";

/**
 * channelGatedOff decides whether a branded channel stays DORMANT (falls back to the default view)
 * because its feature flag is off. Only flag-mapped channels are gated; the read is a single
 * feature_flags lookup. A minimal chainable stub stands in for the Supabase builder.
 */
function dbWithFlag(row: { enabled: boolean } | null): RoamClient {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => Promise.resolve({ data: row }),
  };
  return { from: () => q } as unknown as RoamClient;
}

describe("channelGatedOff", () => {
  it("never gates the ungated default channel (no flag lookup needed)", async () => {
    // If this touched the db it would throw — the stub has no rows — so passing proves the shortcut.
    const db = { from: () => { throw new Error("should not query"); } } as unknown as RoamClient;
    expect(await channelGatedOff(db, "roam")).toBe(false);
  });

  it("gates f2g OFF when its flag is missing or disabled", async () => {
    expect(await channelGatedOff(dbWithFlag(null), "f2g")).toBe(true);
    expect(await channelGatedOff(dbWithFlag({ enabled: false }), "f2g")).toBe(true);
  });

  it("lets f2g resolve live once its flag is enabled", async () => {
    expect(await channelGatedOff(dbWithFlag({ enabled: true }), "f2g")).toBe(false);
  });
});
