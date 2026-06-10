import { describe, it, expect } from "vitest";
import { venuePath } from "./index.js";

describe("venuePath", () => {
  it("builds the singular /venue/[id] path the web route actually serves", () => {
    expect(venuePath("0785d180-0f33-47d1-b5f0-6a8029068a1c")).toBe(
      "/venue/0785d180-0f33-47d1-b5f0-6a8029068a1c",
    );
  });

  it("is singular 'venue', never plural 'venues' (the dispatch deep-link bug)", () => {
    expect(venuePath("x")).not.toContain("/venues/");
  });
});
