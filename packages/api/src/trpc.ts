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
import { isAllowedForScope } from "./internalScopes.js";

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

/**
 * `isDev` decides whether tRPC attaches a stack trace to every error it returns
 * (getErrorShape: `if (config.isDev && typeof error.stack === "string") shape.data.stack = …`).
 * A stack names container paths and exact dependency versions, to whoever asked — including an
 * unauthenticated caller who simply hit a wrong URL. That is free reconnaissance.
 *
 * tRPC's own default is `NODE_ENV !== "production"`, which fails OPEN: any deployment that forgets
 * to set NODE_ENV leaks. Ours fails CLOSED — stacks appear only when someone has explicitly said
 * this is a development run. Production does not have to remember anything to be safe.
 */
const t = initTRPC.context<Context>().create({
  isDev: process.env.NODE_ENV === "development",
});

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

/**
 * Gate: a valid internal-call secret must be present AND its scope must cover this procedure
 * (internalScopes.ts — the web's secret unlocks only the web routes' procedures); exposes a
 * service client.
 */
const requireInternal = middleware(({ ctx, next, path }) => {
  if (!ctx.isInternalCall) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Internal endpoint.",
    });
  }
  if (!isAllowedForScope(ctx.internalScope, path)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Internal endpoint: outside this caller's scope.",
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

  // Resolve the caller's own id and scope the lookup to it EXPLICITLY. Correctness must not rest
  // solely on the admin_users_self_read RLS policy (0113): if that policy were ever broadened or
  // dropped — the review documents ACLs drifting on this schema — a bare `.maybeSingle()` could
  // return an arbitrary staff row and promote every signed-in user to Roam HQ. `.eq("id", uid)`
  // makes this gate hold independent of RLS. Defence in depth, not a live bypass today.
  const { data: authData } = await ctx.db.auth.getUser();
  const uid = authData?.user?.id;
  if (!uid) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This action requires you to be signed in.",
    });
  }

  const { data, error } = await ctx.db
    .from("admin_users")
    .select("id, role")
    .eq("id", uid)
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

/**
 * Gate: an officer of a PARTNER organisation — the Association, not Roam (F2G plan 3.1).
 *
 * The third authority, and the one that is easiest to get catastrophically wrong. adminProcedure
 * grants a named Roam human cross-tenant reach; this grants a partner's officer reach into exactly
 * ONE channel. Get the scoping wrong and one partner reads another partner's members.
 *
 * WHICH CHANNEL IS RESOLVED FROM `channel_admins`, NEVER GRANTED BY THE REQUEST. `ctx.channelKey`
 * comes from the `x-roam-channel` header, which the caller controls — so it is used only to CHOOSE
 * among channels this caller already has an appointment for, never to confer one. An officer of A
 * who sends `x-roam-channel: b` gets a FORBIDDEN, not channel B; the pgTAP suite proves the same
 * containment at the database level, so neither layer is the only thing standing between two
 * partners' data.
 *
 * The appointment is read under the CALLER'S OWN client, against the `channel_admins_self_read`
 * policy — the check that decides whether to escalate must not need the escalated client to run.
 * The lookup is additionally scoped `.eq("profile_id", uid)` rather than trusting RLS alone, for the
 * same reason requireAdmin does it: if that policy were ever broadened, a bare select would return
 * somebody else's appointment and hand the caller their channel.
 */
const requireChannelAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.accessToken) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This action requires you to be signed in.",
    });
  }

  const { data: authData } = await ctx.db.auth.getUser();
  const uid = authData?.user?.id;
  if (!uid) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "This action requires you to be signed in.",
    });
  }

  // `channel_admins` is newer than the checked-in generated types (regenerating them needs a local
  // Supabase replay — see task #22), so this one read goes through the same loose accessor the admin
  // routers already use. The runtime behaviour is unaffected; only the compile-time shape is widened,
  // and the result is narrowed immediately below.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const looseDb = ctx.db as unknown as { from: (t: string) => any };
  const { data, error } = await looseDb
    .from("channel_admins")
    .select("channel_id, role, channels(key, name)")
    .eq("profile_id", uid);

  if (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not verify your access to this organisation.",
    });
  }

  const appointments = (data ?? []) as unknown as {
    channel_id: string;
    role: string;
    channels: { key: string; name: string } | null;
  }[];

  if (appointments.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This area is for partner organisation officers.",
    });
  }

  // The header picks among what the caller already holds; it cannot add to it.
  const requested = ctx.channelKey;
  const chosen =
    appointments.find((a) => a.channels?.key === requested) ??
    (appointments.length === 1 ? appointments[0] : undefined);

  if (!chosen) {
    // Several appointments and the request named none of them. Refusing beats guessing: picking one
    // arbitrarily would silently answer about the wrong organisation.
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "You hold roles at more than one organisation; open the one you mean.",
    });
  }

  // Appointment confirmed. The service client is built here, on this verified path only — and every
  // procedure behind this gate must still scope its reads to ctx.association.channelId, because the
  // service client bypasses RLS.
  const service: RoamClient = escalateToService(ctx.env);
  return next({
    ctx: {
      ...ctx,
      service,
      association: {
        channelId: chosen.channel_id,
        channelKey: chosen.channels?.key ?? null,
        channelName: chosen.channels?.name ?? null,
        role: chosen.role as ChannelAdminRole,
      },
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireUser);
export const internalProcedure = publicProcedure.use(requireInternal);
export const adminProcedure = publicProcedure.use(requireAdmin);
export const associationProcedure = publicProcedure.use(requireChannelAdmin);

/** The authority tiers within Roam HQ; see admin_users.role (migration 0113). */
export type AdminRole = "viewer" | "admin" | "owner";

/**
 * A partner officer's authority within their OWN channel (migration 0156). Deliberately a different
 * vocabulary from AdminRole: these are not Roam staff, and the two must never be confused.
 */
export type ChannelAdminRole = "officer" | "viewer";
