import { describe, it, expect } from "vitest";
import { routeScan, routeUserReport } from "./index.js";

describe("routeScan", () => {
  it("auto-approves clearly clean content", () => {
    const d = routeScan({ score: 0.02, categories: [] });
    expect(d.status).toBe("auto_approved");
    expect(d.enqueueForReview).toBe(false);
  });

  it("auto-flags content in the review band", () => {
    const d = routeScan({ score: 0.55, categories: ["profanity"] });
    expect(d.status).toBe("auto_flagged");
    expect(d.enqueueForReview).toBe(true);
  });

  it("rejects content at/above the reject threshold", () => {
    const d = routeScan({ score: 0.95, categories: ["sexual"] });
    expect(d.status).toBe("rejected");
    expect(d.enqueueForReview).toBe(true);
  });

  it("rejects zero-tolerance categories regardless of score", () => {
    const d = routeScan({ score: 0.01, categories: ["csae"] });
    expect(d.status).toBe("rejected");
    expect(d.enqueueForReview).toBe(true);
  });

  it("respects custom thresholds", () => {
    const d = routeScan(
      { score: 0.3, categories: [] },
      { flagAt: 0.2, rejectAt: 0.9 },
    );
    expect(d.status).toBe("auto_flagged");
  });
});

describe("routeUserReport", () => {
  it("always enqueues for manual review", () => {
    const d = routeUserReport();
    expect(d.enqueueForReview).toBe(true);
    expect(d.status).toBe("pending");
  });
});
