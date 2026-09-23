/**
 * The API must not hand a stack trace to whoever asks.
 *
 * Observed on production 2026-09-23: an unauthenticated GET to a path that fell through to the
 * tRPC handler answered 404 with `data.stack` in the body — container paths (`/app/packages/...`),
 * the pnpm store layout, and exact versions of @trpc/server, typescript and @hono/node-server.
 * That is a free inventory of which CVEs to try, handed to an anonymous caller.
 *
 * Cause: tRPC's `isDev` defaults to `NODE_ENV !== "production"`, and NODE_ENV was set nowhere —
 * not in the Dockerfile, not in railway.json, not in code. The default fails OPEN. trpc.ts now
 * pins `isDev` to an explicit opt-in, so a deployment cannot leak by forgetting something.
 *
 * These tests go through fetchRequestHandler rather than a caller, because the stack is attached
 * when the error is SHAPED for the wire — a direct call never produces the bytes that leaked.
 */
import { describe, it, expect } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "./trpc.js";
import type { Context } from "./context.js";

const testRouter = router({
  boom: publicProcedure.query(() => {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "deliberate" });
  }),
});

/** The procedures under test touch no context, so an empty one is honest here. */
const createContext = () => ({}) as unknown as Context;

async function callAndReadBody(path: string): Promise<string> {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request(`http://api.test/trpc/${path}`),
    router: testRouter,
    createContext,
  });
  return res.text();
}

describe("tRPC error shape", () => {
  it("returns no stack trace when a procedure throws", async () => {
    const body = await callAndReadBody("boom");
    expect(body).toContain("deliberate"); // the error still reaches the client...
    expect(body).not.toContain("stack"); // ...without telling it where we live
  });

  /**
   * The exact shape of the production leak: a path that isn't a procedure at all. This is the one
   * an attacker reaches by accident, with no credentials and no knowledge of the API.
   */
  it("returns no stack trace for an unknown procedure path", async () => {
    const body = await callAndReadBody("integrations/hubspot/callback");
    expect(body).toContain("NOT_FOUND");
    expect(body).not.toContain("stack");
  });

  it("leaks no filesystem path or dependency version in an error body", async () => {
    for (const body of [await callAndReadBody("boom"), await callAndReadBody("nope")]) {
      expect(body).not.toContain("/app/");
      expect(body).not.toContain("node_modules");
      expect(body).not.toMatch(/@trpc\+server@/);
    }
  });
});
