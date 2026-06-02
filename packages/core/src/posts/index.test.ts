import { describe, it, expect } from "vitest";
import {
  validateComposition,
  resolvePublishTiming,
  requiresPushCredit,
  type ComposeInput,
} from "./index.js";

const base: ComposeInput = {
  kind: "news",
  title: "Hello",
  body: "World",
  destinations: ["profile"],
  isDraft: false,
};

describe("validateComposition", () => {
  it("accepts a valid news post on the profile", () => {
    expect(validateComposition(base).ok).toBe(true);
  });

  it("rejects a post with no destinations", () => {
    const r = validateComposition({ ...base, destinations: [] });
    expect(r.ok).toBe(false);
  });

  it("requires the profile as a destination", () => {
    const r = validateComposition({ ...base, destinations: ["feed"] });
    expect(r.ok).toBe(false);
  });

  it("rejects a published post with no title or body", () => {
    const r = validateComposition({
      ...base,
      title: "",
      body: "",
    });
    expect(r.ok).toBe(false);
  });

  it("allows an empty draft (work in progress)", () => {
    const r = validateComposition({
      ...base,
      title: "",
      body: "",
      isDraft: true,
    });
    expect(r.ok).toBe(true);
  });

  it("requires an offer to have a title", () => {
    const r = validateComposition({
      ...base,
      kind: "offer",
      title: "",
      body: "Some details",
    });
    expect(r.ok).toBe(false);
  });
});

describe("resolvePublishTiming", () => {
  const now = new Date("2026-06-02T12:00:00Z");

  it("a draft stays a draft", () => {
    expect(resolvePublishTiming({ ...base, isDraft: true }, now)).toEqual({
      status: "draft",
      at: null,
    });
  });

  it("no publishAt publishes now", () => {
    const r = resolvePublishTiming(base, now);
    expect(r.status).toBe("published");
    expect(r.at).toBe(now.toISOString());
  });

  it("a future publishAt schedules", () => {
    const future = "2026-06-03T12:00:00Z";
    const r = resolvePublishTiming({ ...base, publishAt: future }, now);
    expect(r).toEqual({ status: "scheduled", at: future });
  });

  it("a past publishAt publishes now", () => {
    const past = "2026-06-01T12:00:00Z";
    const r = resolvePublishTiming({ ...base, publishAt: past }, now);
    expect(r.status).toBe("published");
  });
});

describe("requiresPushCredit", () => {
  it("true only for a non-draft with follower_push", () => {
    expect(
      requiresPushCredit({
        ...base,
        destinations: ["profile", "follower_push"],
      }),
    ).toBe(true);
  });

  it("false for a draft even with follower_push", () => {
    expect(
      requiresPushCredit({
        ...base,
        destinations: ["profile", "follower_push"],
        isDraft: true,
      }),
    ).toBe(false);
  });

  it("false without follower_push", () => {
    expect(requiresPushCredit(base)).toBe(false);
  });
});
