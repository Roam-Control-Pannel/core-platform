import { describe, it, expect, vi } from "vitest";
import { isMissingFunctionError, callFoodToGoNear } from "./venues.js";

/**
 * Unit tests for the drift-resilient open-mode storefront supply. The load-bearing behaviour: if the
 * live DB is behind on migration 0145 (no 5-arg venues_food_to_go_near), the storefront must DEGRADE
 * to the legacy 4-arg call — never black out — while a genuine error still propagates.
 */

const args = { origin_lat: 54.5973, origin_lng: -5.9301, page_size: 20, page_offset: 0 };
const CHAN = "00000000-0000-0000-0000-0000000c4a11";

describe("isMissingFunctionError", () => {
  it("is true for the PGRST202 code", () => {
    expect(isMissingFunctionError({ message: "whatever", code: "PGRST202" })).toBe(true);
  });
  it("is true for a schema-cache 'could not find the function' message", () => {
    expect(isMissingFunctionError({ message: "Could not find the function public.venues_food_to_go_near(...) in the schema cache" })).toBe(true);
  });
  it("is false for an unrelated error", () => {
    expect(isMissingFunctionError({ message: "permission denied for relation venues", code: "42501" })).toBe(false);
  });
  it("is false for no error", () => {
    expect(isMissingFunctionError(null)).toBe(false);
  });
});

describe("callFoodToGoNear", () => {
  it("uses the 5-arg (member-ranked) call and returns it when the DB is current", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: "v1" }], error: null });
    const res = await callFoodToGoNear(rpc, args, CHAN);
    expect(res.error).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("venues_food_to_go_near", { ...args, filter_channel_id: CHAN });
  });

  it("falls back to the legacy 4-arg call when the 5-arg signature is missing (0145 not applied)", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: "Could not find the function ... in the schema cache", code: "PGRST202" } })
      .mockResolvedValueOnce({ data: [{ id: "legacy" }], error: null });
    const res = await callFoodToGoNear(rpc, args, CHAN);
    expect(res.error).toBeNull();
    expect((res.data as { id: string }[])[0]?.id).toBe("legacy");
    expect(rpc).toHaveBeenCalledTimes(2);
    // First with the channel, then the legacy call WITHOUT filter_channel_id.
    expect(rpc).toHaveBeenNthCalledWith(1, "venues_food_to_go_near", { ...args, filter_channel_id: CHAN });
    expect(rpc).toHaveBeenNthCalledWith(2, "venues_food_to_go_near", args);
  });

  it("propagates a genuine error without retrying (never masks a real failure)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "permission denied", code: "42501" } });
    const res = await callFoodToGoNear(rpc, args, CHAN);
    expect(res.error?.message).toBe("permission denied");
    expect(rpc).toHaveBeenCalledTimes(1); // no fallback attempt
  });
});
