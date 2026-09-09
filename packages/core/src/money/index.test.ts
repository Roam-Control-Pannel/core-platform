import { describe, it, expect } from "vitest";
import { formatPence } from "./index.js";

describe("formatPence (server-side)", () => {
  it("formats each supported currency with its own symbol", () => {
    expect(formatPence(1250, "gbp")).toBe("£12.50");
    expect(formatPence(1250, "usd")).toBe("$12.50");
    expect(formatPence(1250, "eur")).toBe("€12.50");
  });

  it("drops the minor part for whole amounts", () => {
    expect(formatPence(2500, "gbp")).toBe("£25");
    expect(formatPence(1200, "usd")).toBe("$12");
  });

  it("is case-insensitive and defaults to gbp", () => {
    expect(formatPence(999, "USD")).toBe("$9.99");
    expect(formatPence(999)).toBe("£9.99");
    expect(formatPence(999, null)).toBe("£9.99");
  });

  it("never emits a wrong symbol for an unknown code — prefixes the code instead", () => {
    expect(formatPence(1250, "cad")).toBe("CAD 12.50");
    expect(formatPence(1200, "cad")).toBe("CAD 12"); // whole amount still drops the minor part
  });
});
