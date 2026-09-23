/**
 * HubSpot OAuth (F2G plan 2.3b) — the "Connect your HubSpot" flow, once, for every whitelabel.
 *
 * ONE HubSpot app, MANY partners. A partner clicks Connect, approves scoped read access inside their
 * own portal, and HubSpot hands us a refresh token for that portal. Nothing about adding the next
 * whitelabel requires a Roam engineer to provision credentials by hand — which is the whole reason
 * this is OAuth rather than a per-partner private-app token.
 *
 * WHICH PARTNER IS CONNECTING is carried in the `state` parameter, because a HubSpot app has ONE
 * fixed redirect URI: every partner comes back to the same callback, so the callback has to be told
 * who it is hearing from. That makes `state` security-critical — an attacker who could forge it
 * could bind their own HubSpot portal to someone else's channel. So it is HMAC-signed with an
 * expiry, verified in constant time, exactly like the invite capability tokens in ../f2g/inviteToken.
 *
 * Scopes are read-only: companies and contacts. Roam has no business holding write access to a
 * partner's CRM to do a job that only reads.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { hubspot } from "@roam/core";

/** The read-only scopes a partner is asked to grant. Changing this list requires re-consent. */
export const HUBSPOT_SCOPES = ["crm.objects.companies.read", "crm.objects.contacts.read"] as const;

/** How long a connect link stays valid. Short: it is clicked immediately or not at all. */
export const STATE_TTL_MS = 15 * 60 * 1000;

export interface HubspotAppConfig {
  baseUrl: string;
  /** HubSpot's browser-facing host, where the consent screen lives. */
  appUrl: string;
  clientId: string;
  clientSecret: string;
  /** Must match the redirect URI registered on the HubSpot app, exactly. */
  redirectUri: string;
  /** HMAC secret for the `state` parameter. */
  stateSecret: string;
  propertyMap: hubspot.HubspotPropertyMap;
  pageSize: number;
  maxPages: number;
}

/**
 * Build the app config from env, or null when the app is not provisioned (feature dormant, so the
 * API deploys and runs long before HubSpot exists). Env names match the convention already used for
 * the Kudos Cards integration so the two read the same way.
 */
export function loadHubspotAppConfig(): HubspotAppConfig | null {
  const clientId = process.env.HUBSPOT_CLIENT_ID?.trim();
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET?.trim();
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI?.trim();
  // The state signature reuses the invite secret when a dedicated one is not set: both are
  // capability signatures issued and verified by this same service.
  const stateSecret = process.env.HUBSPOT_STATE_SECRET?.trim() || process.env.F2G_INVITE_SECRET?.trim();
  if (!clientId || !clientSecret || !redirectUri || !stateSecret) return null;

  const pageSize = Number(process.env.HUBSPOT_PAGE_SIZE ?? "100");
  const maxPages = Number(process.env.HUBSPOT_MAX_PAGES ?? "200");
  return {
    baseUrl: (process.env.HUBSPOT_API_BASE ?? "https://api.hubapi.com").replace(/\/+$/, ""),
    appUrl: (process.env.HUBSPOT_APP_BASE ?? "https://app.hubspot.com").replace(/\/+$/, ""),
    clientId,
    clientSecret,
    redirectUri,
    stateSecret,
    propertyMap: hubspot.parsePropertyMap(process.env.HUBSPOT_PROPERTY_MAP),
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 100,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? Math.min(maxPages, 1000) : 200,
  };
}

// ── the signed `state` parameter ────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** `<channelKey>.<expTs>.<nonce>.<hmac>` — the channel this consent is for, and when it stops counting. */
export function signState(channelKey: string, secret: string, ttlMs = STATE_TTL_MS, now = Date.now()): string {
  const expTs = now + ttlMs;
  const nonce = b64url(Buffer.from(String(Math.random()).slice(2) + String(now)));
  const body = `${channelKey}.${expTs}.${nonce}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a returned `state` and recover the channel key. Returns null for anything that is not a
 * currently-valid signature — a forged state, a replayed one past its expiry, or a malformed one.
 * The signature comparison is constant time.
 */
export function verifyState(state: string | null | undefined, secret: string, now = Date.now()): string | null {
  if (!state || !secret) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [channelKey, expRaw, nonce, mac] = parts as [string, string, string, string];
  const expected = sign(`${channelKey}.${expRaw}.${nonce}`, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expTs = Number(expRaw);
  if (!Number.isFinite(expTs) || expTs < now) return null;
  return channelKey || null;
}

/** The URL a partner is sent to in order to approve access. */
export function authorizeUrl(cfg: HubspotAppConfig, channelKey: string): string {
  const qs = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: HUBSPOT_SCOPES.join(" "),
    state: signState(channelKey, cfg.stateSecret),
  });
  return `${cfg.appUrl}/oauth/authorize?${qs.toString()}`;
}

// ── token exchanges ─────────────────────────────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (HubSpot's access tokens are short-lived). */
  expiresIn: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

async function tokenRequest(cfg: HubspotAppConfig, form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${cfg.baseUrl}/oauth/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // HubSpot names the problem in the body (bad redirect_uri, expired code, revoked grant). That is
    // the difference between a five-minute fix and an afternoon, so it is surfaced, not swallowed.
    throw new Error(`HubSpot token exchange failed (HTTP ${res.status}): ${body?.message ?? JSON.stringify(body).slice(0, 300)}`);
  }
  if (!body?.access_token || !body?.refresh_token) {
    throw new Error("HubSpot token exchange returned no tokens");
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token),
    expiresIn: Number(body.expires_in ?? 1800),
  };
}

/** Exchange the one-time `code` from the callback for the partner's tokens. */
export function exchangeCode(cfg: HubspotAppConfig, code: string): Promise<TokenSet> {
  return tokenRequest(cfg, {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code,
  });
}

/** Trade a stored refresh token for a fresh access token (every sync run does this). */
export function refreshAccessToken(cfg: HubspotAppConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(cfg, {
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
  });
}

/**
 * Ask HubSpot which portal an access token belongs to, and which scopes it carries. Recorded at
 * connect time so an operator can confirm the RIGHT portal was connected — the single most common
 * way a multi-tenant OAuth integration goes quietly wrong is a partner approving from the wrong
 * account while logged into two.
 */
export async function describeToken(
  cfg: HubspotAppConfig,
  accessToken: string,
): Promise<{ hubId: string | null; scopes: string[] }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { hubId: null, scopes: [] };
    const body: any = await res.json();
    return {
      hubId: body?.hub_id != null ? String(body.hub_id) : null,
      scopes: Array.isArray(body?.scopes) ? body.scopes.map(String) : [],
    };
  } catch {
    return { hubId: null, scopes: [] }; // introspection is a nicety; never fail a connect over it
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
