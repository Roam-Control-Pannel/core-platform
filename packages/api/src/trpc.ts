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
 *   adminProcedure           — requires a signed-in user who is ALSO a Roam HQ staff
 *                              member (a row in admin_users). This is the third authority:
 *                              a *named* human permitted to read across all tenants. The
 *                              staff check runs under the caller's OWN JWT (admin_users
 *                              self-read RLS), then — and only then — escalates to a
 *                              service-role client (RLS-bypass) via ctx.service, plus
 *                              ctx.admin carrying who they are for attribution/audit.
 *
 * Zod validates every procedure's input at the boundary (the §4 decision). A procedure
 * without an `.input()` schema takes no input by contract.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { createServiceClient, type RoamClient } from "@roam/db";
import type { ApiEnv, Context } from "./context.js";

/**
 * The ONE sanctioned construction site for the RLS-bypassing service client.
 * Both server-side callers go through here: the internal-call gate (below) for
 * external trusted callers, and posts.create for its in-process post-publish
 * dispatch. Naming it keeps the "service client is built in exactly one place"
 * law honest without a pointless in-process HTTP round-trip back through the gate.
 */
export function escalateToService(env: ApiEnv): RoamClient {
  return createServiceClient({
    url: env.supabase.url,
    serviceRoleKey: env.supabaseServiceRoleKey,
  });
}

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
  const service: RoamClient = escalateToService(ctx.env);
  return next({ ctx: { ...ctx, service } });
});

/**
 * Gate: a signed-in user who is a Roam HQ staff member (row in admin_users).
 *
 * The membership check runs under the caller's OWN client — the admin_users
 * self-read RLS policy returns their row iff they're staff, so no privileged key
 * is needed merely to answer "are you staff?". Passing that gate, we escalate to a
 * service-role client (ctx.service, RLS bypassed) for the cross-tenant reads/writes
 * Roam HQ needs, and attach ctx.admin (id + role) so actions can be attributed and
 * audited. `role` distinguishes observe-only viewers from those who may act.
 */
const requireAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.accessToken) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This action requires you to be signed in.",
    });
  }

  const { data, error } = await ctx.db
    .from("admin_users")
    .select("id, role")
    .maybeSingle();

  if (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not verify Roam HQ access.",
    });
  }
  if (!data) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Roam HQ is staff-only.",
    });
  }

  // Staff confirmed. Build the RLS-bypassing client here, on this verified path only.
  const service: RoamClient = escalateToService(ctx.env);
  return next({
    ctx: {
      ...ctx,
      service,
      admin: { id: data.id, role: data.role as AdminRole },
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireUser);
export const internalProcedure = publicProcedure.use(requireInternal);
export const adminProcedure = publicProcedure.use(requireAdmin);

/** The authority tiers within Roam HQ; see admin_users.role (migration 0113). */
export type AdminRole = "viewer" | "admin" | "owner";
