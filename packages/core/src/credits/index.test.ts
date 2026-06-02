import { describe, it, expect } from "vitest";
import {
  computeBalance,
  canAfford,
  type LedgerEntry,
} from "./index.js";

describe("computeBalance", () => {
  it("sums an append-only ledger including refund credit-backs", () => {
    const ledger: LedgerEntry[] = [
      { delta: 100, reason: "purchase" },
      { delta: -10, reason: "send" },
      { delta: -10, reason: "send" },
      { delta: 10, reason: "refund" }, // refund is a NEW positive entry, never an edit
    ];
    expect(computeBalance(ledger)).toBe(90);
  });

  it("is zero for an empty ledger", () => {
    expect(computeBalance([])).toBe(0);
  });
});

describe("canAfford", () => {
  it("affordable when balance covers cost", () => {
    const r = canAfford([{ delta: 5, reason: "grant" }], 3);
    expect(r).toEqual({ ok: true, balance: 5, shortfall: 0 });
  });

  it("reports shortfall when balance is insufficient", () => {
    const r = canAfford([{ delta: 2, reason: "grant" }], 3);
    expect(r).toEqual({ ok: false, balance: 2, shortfall: 1 });
  });

  it("a zero-cost send is always allowed", () => {
    const r = canAfford([], 0);
    expect(r.ok).toBe(true);
  });

  it("rejects a negative cost", () => {
    expect(() => canAfford([], -1)).toThrow();
  });
});
