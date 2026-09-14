import { describe, it, expect } from "vitest";
import { isEmploymentType, normaliseApplyUrl, EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABEL } from "./index.js";

describe("isEmploymentType", () => {
  it("accepts known types and rejects everything else", () => {
    expect(isEmploymentType("full_time")).toBe(true);
    expect(isEmploymentType("apprenticeship")).toBe(true);
    expect(isEmploymentType("ceo")).toBe(false);
    expect(isEmploymentType(null)).toBe(false);
    expect(isEmploymentType(undefined)).toBe(false);
  });

  it("has a label for every type", () => {
    for (const t of EMPLOYMENT_TYPES) expect(EMPLOYMENT_TYPE_LABEL[t]).toBeTruthy();
  });
});

describe("normaliseApplyUrl", () => {
  it("accepts and normalises http(s) URLs", () => {
    expect(normaliseApplyUrl("https://jobs.example/apply")).toBe("https://jobs.example/apply");
    expect(normaliseApplyUrl("  http://x.example/a  ")).toBe("http://x.example/a");
  });

  it("rejects non-http(s), empty, malformed, and over-long", () => {
    expect(normaliseApplyUrl("mailto:hr@x.example")).toBeNull(); // no PII/email apply path
    expect(normaliseApplyUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseApplyUrl("not a url")).toBeNull();
    expect(normaliseApplyUrl("")).toBeNull();
    expect(normaliseApplyUrl(null)).toBeNull();
    expect(normaliseApplyUrl(`https://x.example/${"a".repeat(2001)}`)).toBeNull();
  });
});
