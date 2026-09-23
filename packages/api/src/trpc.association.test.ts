/**
 * associationProcedure — the gate that lets a PARTNER's officer in (F2G plan 3.1).
 *
 * These are security tests. adminProcedure grants cross-tenant reach to Roam staff; this grants a
 * partner officer reach into exactly one channel, and the failure mode is one partner reading
 * another partner's members. The property under test is that the channel comes from the caller's
 * appointment in `channel_admins` and NOT from `x-roam-channel`, which the caller controls.
 *
 * The database enforces the same containment (supabase/tests/0156_channel_admins_test.sql). Both
 * layers are tested because neither should be the only thing between two partners' data.
 */
import { describe, it, expect } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { router, associationProcedure } from "./trpc.js";
import type { Context } from "./context.js";

const UID = "00000000-0000-0000-0000-0000000000a1";

type Appointment = { channel_id: string; role: string; channels: { key: string; name: string } | null };

const A: Appointment = { channel_id: "chan-a", role: "officer", channels: { key: "assoc-a", name: "Association A" } };
const B: Appointment = { channel_id: "chan-b", role: "viewer", channels: { key: "assoc-b", name: "Association B" } };

/** Records the filters the gate applied, so "scoped to the caller" is asserted, not assumed. */
interface Probe {
  eqCalls: [string, unknown][];
}

function makeCtx(opts: {
  signedIn?: boolean;
  appointments: Appointment[];
  channelKey: string;
  probe?: Probe;
}): Context {
  const signedIn = opts.signedIn !== false;
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      opts.probe?.eqCalls.push([col, val]);
      return q;
    },
    then: (resolve: (r: { data: Appointment[]; error: null }) => unknown) =>
      resolve({ data: opts.appointments, error: null }),
  };
  return {
    accessToken: signedIn ? "jwt" : null,
    db: {
      auth: { getUser: async () => ({ data: { user: signedIn ? { id: UID } : null } }) },
      from: () => q,
    },
    channelKey: opts.channelKey,
    // escalateToService builds a Supabase client from these; it makes no network call at construction.
    env: { supabase: { url: "https://stub.supabase.test" }, supabaseServiceRoleKey: "stub-service-key" },
  } as unknown as Context;
}

const testRouter = router({
  whoami: associationProcedure.query(({ ctx }) => ctx.association),
});

async function call(ctx: Context): Promise<{ status: number; body: any }> {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request("http://api.test/trpc/whoami"),
    router: testRouter,
    createContext: () => ctx,
  });
  return { status: res.status, body: await res.json() };
}

describe("associationProcedure", () => {
  it("refuses an anonymous caller", async () => {
    const { body } = await call(makeCtx({ signedIn: false, appointments: [], channelKey: "assoc-a" }));
    expect(body.error.data.code).toBe("UNAUTHORIZED");
  });

  it("refuses a signed-in user who holds no appointment anywhere", async () => {
    const { body } = await call(makeCtx({ appointments: [], channelKey: "assoc-a" }));
    expect(body.error.data.code).toBe("FORBIDDEN");
  });

  it("binds the single channel the caller is an officer of", async () => {
    const { body } = await call(makeCtx({ appointments: [A], channelKey: "assoc-a" }));
    expect(body.result.data.channelId).toBe("chan-a");
    expect(body.result.data.role).toBe("officer");
  });

  /**
   * THE one that matters. An officer of A asks for B by header. They must get A — the header selects
   * among appointments the caller already holds, it never confers one.
   */
  it("does not hand over another channel just because the header asks for it", async () => {
    const { body } = await call(makeCtx({ appointments: [A], channelKey: "assoc-b" }));
    expect(body.result.data.channelId).toBe("chan-a");
    expect(body.result.data.channelId).not.toBe("chan-b");
  });

  it("lets a genuine multi-channel officer choose between their OWN channels", async () => {
    const { body } = await call(makeCtx({ appointments: [A, B], channelKey: "assoc-b" }));
    expect(body.result.data.channelId).toBe("chan-b");
    expect(body.result.data.role).toBe("viewer");
  });

  it("refuses to guess when several appointments exist and none was named", async () => {
    // Picking one arbitrarily would silently answer about the wrong organisation.
    const { body } = await call(makeCtx({ appointments: [A, B], channelKey: "roam" }));
    expect(body.error.data.code).toBe("PRECONDITION_FAILED");
  });

  it("scopes the appointment lookup to the caller rather than trusting RLS alone", async () => {
    const probe: Probe = { eqCalls: [] };
    await call(makeCtx({ appointments: [A], channelKey: "assoc-a", probe }));
    expect(probe.eqCalls).toContainEqual(["profile_id", UID]);
  });
});
