/**
 * tRPC initialisation + the procedure vocabulary the routers build on.
 *
 * Three procedure kinds, by authority:
 *
 *   publicProcedure          — anyone, including anonymous. Used for public reads
 *                              (browse venues, read a public post). RLS still applies
 *                              via the user/anon client; this just doesn't require auth.
 *
 *   protectedProcedure       — requires a signed-in user (a JWT was presented). Used
 *                              for anything that writes as a user or reads private data.
 *                              RLS enforces row ownership; this enforces "is logged in".
 *
 *   internalProcedure        — requires a valid x-internal-call secret. Used by Edge
 *                              Functions / cron / webhook. Exposes a service-role client
 *                              (RLS-bypass) via ctx — built LAZILY and only here, so the
 *                              dangerous client never exists on a normal user path.
 *
 * Zod validates every procedure's input at the boundary (the §4 decision). A procedure
 * without an `.input()` schema takes no input by contract.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { createServiceClient, type RoamClient } from "@roam/db";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

/** Gate: a user JWT must be present. */
const requireUser = middleware(({ ctx, next }) => {
  if (!ctx.accessToken) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This action requires you to be signed in.",
    });
  }
  return next({ ctx: { ...ctx, accessToken: ctx.accessToken } });
});

/** Gate: a valid internal-call secret must be present; exposes a service client. */
const requireInternal = middleware(({ ctx, next }) => {
  if (!ctx.isInternalCall) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Internal endpoint.",
    });
  }
  // Service-role client built lazily, ONLY on a verified internal call. RLS bypassed.
  const service: RoamClient = createServiceClient({
    url: ctx.env.supabase.url,
    serviceRoleKey: ctx.env.supabaseServiceRoleKey,
  });
  return next({ ctx: { ...ctx, service } });
});

export const protectedProcedure = publicProcedure.use(requireUser);
export const internalProcedure = publicProcedure.use(requireInternal);
