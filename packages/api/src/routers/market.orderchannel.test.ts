import { describe, it, expect } from "vitest";
import { pickOrderChannel } from "./market.js";

/**
 * Unit tests for the PURE half of order-channel resolution (0149). The RPC decides the channel
 * server-side; this maps its row to the checkout's channel + fee, and its load-bearing property is
 * that the fee can only ever be the channel's or the env default — never absent, never a value
 * outside the DB bound, never something a client supplied.
 */
describe("pickOrderChannel", () => {
  it("takes the channel and its fee from the RPC row", () => {
    expect(pickOrderChannel([{ channel_id: "c-f2g", channel_key: "f2g", platform_fee_bps: 700 }], 500)).toEqual({
      channelId: "c-f2g",
      channelKey: "f2g",
      feeBps: 700,
    });
  });

  it("accepts a single-object result as well as a one-row array", () => {
    expect(pickOrderChannel({ channel_id: "c-roam", channel_key: "roam", platform_fee_bps: 500 }, 800).feeBps).toBe(500);
  });

  it("falls back to the env fee with no channel when the RPC returns nothing", () => {
    expect(pickOrderChannel([], 500)).toEqual({ channelId: null, channelKey: null, feeBps: 500 });
    expect(pickOrderChannel(null, 500)).toEqual({ channelId: null, channelKey: null, feeBps: 500 });
    expect(pickOrderChannel(undefined, 500).feeBps).toBe(500);
  });

  it("keeps the channel but uses the env fee when the row's fee is missing or out of bounds", () => {
    expect(pickOrderChannel([{ channel_id: "c", channel_key: "f2g" }], 500)).toEqual({ channelId: "c", channelKey: "f2g", feeBps: 500 });
    expect(pickOrderChannel([{ channel_id: "c", channel_key: "f2g", platform_fee_bps: 9999 }], 500).feeBps).toBe(500);
    expect(pickOrderChannel([{ channel_id: "c", channel_key: "f2g", platform_fee_bps: -1 }], 500).feeBps).toBe(500);
    expect(pickOrderChannel([{ channel_id: "c", channel_key: "f2g", platform_fee_bps: 7.5 }], 500).feeBps).toBe(500);
  });

  it("honours a genuine 0% channel fee (does not confuse 0 with missing)", () => {
    expect(pickOrderChannel([{ channel_id: "c", channel_key: "free", platform_fee_bps: 0 }], 500).feeBps).toBe(0);
  });

  it("ignores a malformed row (no channel id/key) entirely", () => {
    expect(pickOrderChannel([{ platform_fee_bps: 700 }], 500)).toEqual({ channelId: null, channelKey: null, feeBps: 500 });
  });
});
