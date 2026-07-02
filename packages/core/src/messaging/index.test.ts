import { describe, it, expect } from "vitest";
import { validateMessage, MESSAGE_KINDS } from "./index.js";

const UUID = "0785d180-0f33-47d1-b5f0-6a8029068a1c";

describe("validateMessage", () => {
  it("defaults to text and requires a non-empty body", () => {
    expect(validateMessage({ body: "hi" })).toEqual({
      ok: true,
      message: { kind: "text", body: "hi", payload: null },
    });
    expect(validateMessage({ kind: "text", body: "   " }).ok).toBe(false);
    expect(validateMessage({ kind: "text" }).ok).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const r = validateMessage({ kind: "sticker", body: "x" });
    expect(r.ok).toBe(false);
  });

  it("validates a venue_card and trims the name", () => {
    const r = validateMessage({ kind: "venue_card", payload: { venueId: UUID, name: "  The Dark Horse  " } });
    expect(r).toEqual({
      ok: true,
      message: { kind: "venue_card", body: null, payload: { venueId: UUID, name: "The Dark Horse" } },
    });
  });

  it("keeps an optional caption on a rich card", () => {
    const r = validateMessage({ kind: "venue_card", body: "let's go here", payload: { venueId: UUID, name: "X" } });
    expect(r.ok && r.message.body).toBe("let's go here");
  });

  it("rejects a venue_card with a bad id or missing name", () => {
    expect(validateMessage({ kind: "venue_card", payload: { venueId: "nope", name: "X" } }).ok).toBe(false);
    expect(validateMessage({ kind: "venue_card", payload: { venueId: UUID, name: "" } }).ok).toBe(false);
    expect(validateMessage({ kind: "venue_card" }).ok).toBe(false);
  });

  it("validates plan_card and profile_card", () => {
    expect(validateMessage({ kind: "plan_card", payload: { planId: UUID, title: "Trip" } }).ok).toBe(true);
    const p = validateMessage({ kind: "profile_card", payload: { profileId: UUID, name: "Andy", handle: "@andy" } });
    expect(p.ok && p.message.payload).toEqual({ profileId: UUID, name: "Andy", handle: "andy" });
  });

  it("normalizes profile_card handle to null when blank", () => {
    const p = validateMessage({ kind: "profile_card", payload: { profileId: UUID, name: "Andy", handle: "  " } });
    expect(p.ok && (p.message.payload as { handle: string | null }).handle).toBe(null);
  });

  it("validates an image payload with optional dims", () => {
    const r = validateMessage({ kind: "image", payload: { path: "chat/abc.jpg", width: 800, height: 600, mime: "image/jpeg" } });
    expect(r).toEqual({
      ok: true,
      message: { kind: "image", body: null, payload: { path: "chat/abc.jpg", width: 800, height: 600, mime: "image/jpeg" } },
    });
    expect(validateMessage({ kind: "image", payload: { path: "" } }).ok).toBe(false);
    const noDims = validateMessage({ kind: "image", payload: { path: "chat/x.png" } });
    expect(noDims.ok && noDims.message.payload).toEqual({ path: "chat/x.png", width: null, height: null, mime: null });
  });

  it("rejects a rich kind with no payload object", () => {
    expect(validateMessage({ kind: "plan_card", payload: null }).ok).toBe(false);
    expect(validateMessage({ kind: "plan_card", payload: "x" }).ok).toBe(false);
  });

  it("exposes every kind", () => {
    expect(MESSAGE_KINDS).toContain("text");
    expect(MESSAGE_KINDS).toContain("venue_card");
    expect(MESSAGE_KINDS).toContain("image");
  });
});
