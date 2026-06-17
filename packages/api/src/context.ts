/**
 * Request context for every tRPC procedure.
 *
 * Two ways a call reaches the api:
 *
 *   1. A user shell (web/console/native) — carries the caller's Supabase JWT in the
 *      Authorization header. We build a USER client bound to that token, so every
 *      query runs under that user's RLS (`auth.uid()` is them). No JWT = anonymous
 *      role, which is correct for public browsing (unclaimed venues are world-readable).
 *
 *   2. A trusted server (Edge Function / cron / Stripe webhook) — carries
 *      `x-internal-call: <secret>`. This marks the call as internal so a procedure
 *      MAY escalate to a service-role client (RLS bypass) when it legitimately needs
 *      to act server-to-server. We do NOT build the service client here eagerly — we
 *      only record that the call is trusted, and the procedure asks for it explicitly
 *      (see protectedInternalProcedure in trpc.ts). Least authority by default.
 *
 * This module is transport-agnostic: it takes a plain headers bag, so the same
 * context factory works behind a fetch adapter, a Next route handler, or a test.
 */
import {
  createUserClient,
  type PublicSupabaseConfig,
  type RoamClient,
} from "@roam/db";

/** A minimal, transport-agnostic view of the incoming request's headers. */
export interface HeaderBag {
  get(name: string): string | null | undefined;
}

/** Server-side env the api needs. Read once at boot, passed into the factory. */
export interface ApiEnv {
  supabase: PublicSupabaseConfig;
  /** Service-role key — server-only, used lazily for internal-call escalation. */
  supabaseServiceRoleKey: string;
  /** Shared secret that marks a call as trusted server-to-server. */
  internalCallSecret: string;
  /**
   * Web Push (VAPID) signing config. Server-only. Note the public key is read from
   * NEXT_PUBLIC_VAPID_PUBLIC_KEY (the SAME value the web bundle inlines) — web-push's
   * setVapidDetails needs BOTH keys to sign, so the send path reads the public key too;
   * the private key + subject are unprefixed server-only secrets.
   */
  vapid: {
    subject: string;
    publicKey: string;
    privateKey: string;
  };
  /** Google Places (New) API key — server-only, used for on-demand venue ingestion. */
  places: {
    apiKey: string;
  };
}

export interface Context {
  /** RLS-enforced client bound to the caller's JWT (or anonymous). */
  db: RoamClient;
  /** The caller's access token, if they sent one. */
  accessToken: string | null;
  /** True iff a valid `x-internal-call` secret was presented. */
  isInternalCall: boolean;
  /** Server env, carried so procedures can lazily build a service client. */
  env: ApiEnv;
}

const BEARER = /^Bearer\s+(.+)$/i;

function extractAccessToken(headers: HeaderBag): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const m = BEARER.exec(raw.trim());
  return m?.[1]?.trim() ?? null;
}

/**
 * Constant-time-ish comparison for the internal secret. Not a substitute for a
 * real MAC, but avoids the most naive early-exit length leak and matches the
 * header-secret pattern carried over from the Roam CRM.
 */
function secretMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build the per-request context. Curry the env at boot, then call per request
 * with that request's headers.
 *
 *   const createContext = makeContextFactory(env);
 *   // ...adapter calls createContext({ headers })
 */
export function makeContextFactory(env: ApiEnv) {
  return function createContext({ headers }: { headers: HeaderBag }): Context {
    const accessToken = extractAccessToken(headers);
    const isInternalCall = secretMatches(
      headers.get("x-internal-call"),
      env.internalCallSecret,
    );

    const db = accessToken
      ? createUserClient(env.supabase, accessToken)
      : createUserClient(env.supabase);

    return { db, accessToken, isInternalCall, env };
  };
}

export type CreateContext = ReturnType<typeof makeContextFactory>;
