/**
 * Push-credit accounting.
 *
 * Credits live in an append-only ledger (push_credit_ledger): positive deltas are
 * grants/purchases, negative deltas are consumption by a push send. The balance is
 * the sum. Append-only means we never mutate history — a refund is a NEW positive
 * entry, never an edit. This mirrors the billing model where charge.refunded is a
 * real state change (the DDS gap we closed), applied here as a ledger credit-back.
 *
 * Pure functions compute; the orchestrator persists.
 */
import type { RoamClient } from "@roam/db";

export type LedgerReason =
  | "grant"
  | "purchase"
  | "send"
  | "refund"
  | "adjustment";

export interface LedgerEntry {
  delta: number;
  reason: LedgerReason;
}

/** Sum the ledger to a current balance. Pure. */
export function computeBalance(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + e.delta, 0);
}

/**
 * Can this venue afford to send `cost` credits? Pure.
 *
 * example: balance 5, cost 3  -> { ok:true,  balance:5, shortfall:0 }
 * example: balance 2, cost 3  -> { ok:false, balance:2, shortfall:1 }
 * example: cost 0             -> { ok:true } (no-op send still allowed)
 */
export function canAfford(
  entries: readonly LedgerEntry[],
  cost: number,
): { ok: boolean; balance: number; shortfall: number } {
  if (cost < 0) throw new Error("Push send cost cannot be negative");
  const balance = computeBalance(entries);
  const shortfall = Math.max(0, cost - balance);
  return { ok: shortfall === 0, balance, shortfall };
}

/** Load the ledger entries for a venue. */
async function loadLedger(
  client: RoamClient,
  venueId: string,
): Promise<LedgerEntry[]> {
  const { data, error } = await client
    .from("push_credit_ledger")
    .select("delta, reason")
    .eq("venue_id", venueId);
  if (error) throw new Error(`Failed to load credit ledger: ${error.message}`);
  return (data ?? []).map((r) => ({
    delta: r.delta as number,
    reason: r.reason as LedgerReason,
  }));
}

/** Current credit balance for a venue. */
export async function getBalance(
  client: RoamClient,
  venueId: string,
): Promise<number> {
  return computeBalance(await loadLedger(client, venueId));
}

/**
 * Consume credits for a push send. Checks affordability against the live ledger,
 * then appends a negative entry. Returns the new balance.
 *
 * NOTE: append-only + sum-balance means concurrent sends could in theory both
 * pass the check and overspend. For launch volumes this is acceptable; when it
 * matters we move the check+append into a single Postgres function (atomic).
 * Flagged here rather than over-engineered now.
 */
export async function consumeForSend(
  client: RoamClient,
  venueId: string,
  cost: number,
  ref: string,
): Promise<{ ok: boolean; balance: number; shortfall: number }> {
  const entries = await loadLedger(client, venueId);
  const affordability = canAfford(entries, cost);
  if (!affordability.ok) return affordability;

  if (cost > 0) {
    const { error } = await client.from("push_credit_ledger").insert({
      venue_id: venueId,
      delta: -cost,
      reason: "send",
      ref,
    });
    if (error) throw new Error(`Failed to record credit consumption: ${error.message}`);
  }

  return { ...affordability, balance: affordability.balance - cost };
}

/**
 * Credit back a venue (grant, purchase, refund, or adjustment) by appending a
 * positive entry. A refund is just reason:"refund" — never an edit of history.
 */
export async function creditVenue(
  client: RoamClient,
  venueId: string,
  amount: number,
  reason: Exclude<LedgerReason, "send">,
  ref: string,
): Promise<number> {
  if (amount <= 0) throw new Error("Credit amount must be positive");
  const { error } = await client.from("push_credit_ledger").insert({
    venue_id: venueId,
    delta: amount,
    reason,
    ref,
  });
  if (error) throw new Error(`Failed to credit venue: ${error.message}`);
  return getBalance(client, venueId);
}
