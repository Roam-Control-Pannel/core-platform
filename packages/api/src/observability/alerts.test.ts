import { describe, it, expect, vi } from "vitest";
import { createAlertSink, formatAlert } from "./alerts.js";

/**
 * The alert sink's load-bearing properties: it never throws, it de-duplicates by key within the
 * window, it degrades to stderr when no webhook is configured, and the message carries source,
 * title, key and time.
 */
describe("formatAlert", () => {
  it("renders severity, source, title, detail (bounded) and key", () => {
    const { text, content } = formatAlert("api", { key: "k", title: "Boom", detail: "x".repeat(2000), severity: "warn" }, new Date("2026-09-17T10:00:00Z"));
    expect(text.startsWith("[WARN] api — Boom\n")).toBe(true);
    expect(text).toContain("key: k · 2026-09-17T10:00:00.000Z");
    expect(text.length).toBeLessThan(1_700);
    expect(content).toBe(text);
  });
});

describe("createAlertSink", () => {
  it("posts JSON to the webhook and de-duplicates the same key inside the window", async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const { notifyOps } = createAlertSink({ webhookUrl: "https://hooks.example/x", source: "api", now: () => t, fetchImpl: fetchImpl as unknown as typeof fetch, dedupeMs: 10_000 });

    expect(await notifyOps({ key: "a", title: "first" })).toBe(true);
    expect(await notifyOps({ key: "a", title: "again" })).toBe(false); // deduped
    expect(await notifyOps({ key: "b", title: "other key" })).toBe(true);
    t += 10_001;
    expect(await notifyOps({ key: "a", title: "after window" })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/x");
    const body = JSON.parse(String(init.body)) as { text: string; content: string };
    expect(body.text).toContain("[ERROR] api — first");
    expect(body.content).toBe(body.text);
  });

  it("logs to stderr instead of throwing when no webhook is configured", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { notifyOps } = createAlertSink({ webhookUrl: null, source: "job:fsa" });
    expect(await notifyOps({ key: "x", title: "no receiver" })).toBe(true);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("[alert:job:fsa] [ERROR] job:fsa — no receiver"));
    err.mockRestore();
  });

  it("swallows a failing or non-2xx webhook (an alert must never take the caller down)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = vi.fn(async () => { throw new Error("network down"); });
    const s1 = createAlertSink({ webhookUrl: "https://hooks.example/x", source: "api", fetchImpl: boom as unknown as typeof fetch });
    await expect(s1.notifyOps({ key: "k1", title: "t" })).resolves.toBe(true);
    const bad = vi.fn(async () => new Response("nope", { status: 500 }));
    const s2 = createAlertSink({ webhookUrl: "https://hooks.example/x", source: "api", fetchImpl: bad as unknown as typeof fetch });
    await expect(s2.notifyOps({ key: "k2", title: "t" })).resolves.toBe(true);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
