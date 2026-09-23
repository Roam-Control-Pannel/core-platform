/**
 * channel_integrations store — the only place a partner's refresh token is written or read.
 *
 * Keeping it to one module means there is exactly one call site to audit for "does a plaintext
 * credential escape here": `connectIntegration` seals on the way in, `accessTokenFor` opens on the
 * way out and immediately trades it for a short-lived access token. Nothing else in the codebase
 * touches `refresh_token_encrypted`.
 *
 * Access tokens are cached in memory per channel until shortly before they expire, so a long-running
 * API process does not re-authenticate on every call, and a nightly cron does it once.
 */
import type { RoamClient } from "@roam/db";
import { sealSecret, openSecret } from "../integrations/secretBox.js";
import { refreshAccessToken, describeToken, type HubspotAppConfig, type TokenSet } from "./oauth.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

const PROVIDER = "hubspot";

export interface IntegrationRow {
  id: string;
  channelId: string;
  externalAccountId: string | null;
  scopes: string[];
  status: "connected" | "revoked" | "error";
  lastError: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

/** Public-safe view of a connection — never includes the credential. */
export function toStatus(row: IntegrationRow | null) {
  if (!row) return { connected: false as const };
  return {
    connected: row.status === "connected",
    status: row.status,
    portalId: row.externalAccountId,
    scopes: row.scopes,
    connectedAt: row.connectedAt,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
  };
}

function mapRow(r: any): IntegrationRow {
  return {
    id: String(r.id),
    channelId: String(r.channel_id),
    externalAccountId: r.external_account_id ?? null,
    scopes: Array.isArray(r.scopes) ? r.scopes.map(String) : [],
    status: (r.status ?? "connected") as IntegrationRow["status"],
    lastError: r.last_error ?? null,
    connectedAt: r.connected_at ?? null,
    lastSyncAt: r.last_sync_at ?? null,
  };
}

/** The channel's HubSpot connection, without its credential. */
export async function getIntegration(client: RoamClient, channelId: string): Promise<IntegrationRow | null> {
  const { data, error } = await loose(client)
    .from("channel_integrations")
    .select("id, channel_id, external_account_id, scopes, status, last_error, connected_at, last_sync_at")
    .eq("channel_id", channelId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`hubspot store: read failed: ${error.message}`);
  return data ? mapRow(data) : null;
}

/** Every channel with a working HubSpot connection — what the nightly cron iterates. */
export async function listConnectedChannels(client: RoamClient): Promise<{ channelId: string }[]> {
  const { data, error } = await loose(client)
    .from("channel_integrations")
    .select("channel_id")
    .eq("provider", PROVIDER)
    .eq("status", "connected");
  if (error) throw new Error(`hubspot store: connected-channel read failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({ channelId: String(r.channel_id) }));
}

/**
 * Record a completed OAuth grant. Re-connecting REPLACES the row (the unique index makes that the
 * only possibility), so an old refresh token is never left behind for nobody to revoke.
 */
export async function connectIntegration(
  client: RoamClient,
  args: {
    channelId: string;
    tokens: TokenSet;
    externalAccountId: string | null;
    scopes: string[];
    connectedBy?: string | null | undefined;
  },
): Promise<void> {
  // Seals with the environment key, or throws — a credential is never written in the clear.
  const sealed = sealSecret(args.tokens.refreshToken);
  const { error } = await loose(client)
    .from("channel_integrations")
    .upsert(
      {
        channel_id: args.channelId,
        provider: PROVIDER,
        refresh_token_encrypted: sealed,
        external_account_id: args.externalAccountId,
        scopes: args.scopes,
        status: "connected",
        last_error: null,
        connected_by: args.connectedBy ?? null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "channel_id,provider", ignoreDuplicates: false },
    );
  if (error) throw new Error(`hubspot store: connect write failed: ${error.message}`);
}

/** Forget a partner's credential entirely. The partner should also uninstall the app their side. */
export async function disconnectIntegration(client: RoamClient, channelId: string): Promise<void> {
  const { error } = await loose(client)
    .from("channel_integrations")
    .delete()
    .eq("channel_id", channelId)
    .eq("provider", PROVIDER);
  if (error) throw new Error(`hubspot store: disconnect failed: ${error.message}`);
}

/** Mark a connection broken, with the reason, so an operator sees it before the next failed sync. */
export async function markIntegrationError(client: RoamClient, channelId: string, message: string): Promise<void> {
  const revoked = /revoked|invalid_grant|expired/i.test(message);
  await loose(client)
    .from("channel_integrations")
    .update({ status: revoked ? "revoked" : "error", last_error: message.slice(0, 500) })
    .eq("channel_id", channelId)
    .eq("provider", PROVIDER);
}

/** Stamp a successful run, so "last synced" is visible without reading the import history. */
export async function markSynced(client: RoamClient, channelId: string): Promise<void> {
  await loose(client)
    .from("channel_integrations")
    .update({ last_sync_at: new Date().toISOString(), status: "connected", last_error: null })
    .eq("channel_id", channelId)
    .eq("provider", PROVIDER);
}

// ── access tokens ───────────────────────────────────────────────────────────────────────────────

/** Cached access tokens, per channel. Short-lived by construction; never persisted. */
const cache = new Map<string, { token: string; expiresAt: number }>();
const EXPIRY_MARGIN_MS = 60_000; // refresh a minute early rather than race a 401

/**
 * A usable access token for this channel, refreshing when needed.
 *
 * Throws when the channel has no connection, or when the partner has revoked the grant — and records
 * the latter on the row, because a revoked integration is an operational fact someone must see, not
 * an error to retry into.
 */
export async function accessTokenFor(
  client: RoamClient,
  cfg: HubspotAppConfig,
  channelId: string,
): Promise<string> {
  const hit = cache.get(channelId);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const { data, error } = await loose(client)
    .from("channel_integrations")
    .select("refresh_token_encrypted, status")
    .eq("channel_id", channelId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`hubspot store: credential read failed: ${error.message}`);
  if (!data) throw new Error("hubspot: this channel has no HubSpot connection");

  const refreshToken = openSecret(String((data as any).refresh_token_encrypted));
  let tokens: TokenSet;
  try {
    tokens = await refreshAccessToken(cfg, refreshToken);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markIntegrationError(client, channelId, message);
    throw new Error(`hubspot: could not refresh the access token — ${message}`);
  }

  // HubSpot may rotate the refresh token on use; store the new one or the next run is locked out.
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    const { error: upErr } = await loose(client)
      .from("channel_integrations")
      .update({ refresh_token_encrypted: sealSecret(tokens.refreshToken) })
      .eq("channel_id", channelId)
      .eq("provider", PROVIDER);
    if (upErr) throw new Error(`hubspot store: refresh-token rotation write failed: ${upErr.message}`);
  }

  cache.set(channelId, {
    token: tokens.accessToken,
    expiresAt: Date.now() + Math.max(0, tokens.expiresIn * 1000 - EXPIRY_MARGIN_MS),
  });
  return tokens.accessToken;
}

/** Drop any cached token for a channel (used on disconnect, and by tests). */
export function forgetCachedToken(channelId?: string): void {
  if (channelId) cache.delete(channelId);
  else cache.clear();
}

/** Introspect a freshly-granted token to learn the portal id and scopes. */
export { describeToken };
/* eslint-enable @typescript-eslint/no-explicit-any */
