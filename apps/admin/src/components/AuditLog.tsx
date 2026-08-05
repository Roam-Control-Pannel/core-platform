/**
 * AuditLog — the privileged-action trail (adminActivity.auditLog): who did what, when.
 * Every HQ action (ban, suspend, resolve, claim decision) writes a row here, attributed
 * to the acting staff member. Read-only; newest first.
 */
"use client";

import { useEffect, useState } from "react";
import { Card } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, Kicker, SkeletonBlock, timeAgo } from "./ui";

interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  ban_user: "banned a user",
  unban_user: "un-banned a user",
  suspend_venue: "suspended a venue",
  restore_venue: "restored a venue",
  approve_claim: "approved a claim",
  reject_claim: "rejected a claim",
  resolve_report: "resolved a report",
};

export function AuditLog() {
  const trpc = useTrpc();
  const [entries, setEntries] = useState<AuditEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminActivity.auditLog.query({ limit: 20 }) as Promise<AuditEntry[]>)
      .then((d) => !cancelled && setEntries(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load audit log."));
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return (
    <Card style={{ padding: "var(--space-5)" }}>
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Kicker tone="crimson">Audit trail</Kicker>
      </div>
      {error ? (
        <ErrorLine message={error} />
      ) : !entries ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonBlock key={i} height={28} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>No actions recorded yet.</div>
      ) : (
        <div style={{ display: "grid" }}>
          {entries.map((e, i) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-2) 0",
                borderTop: i === 0 ? "none" : "1px solid var(--line)",
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              <strong style={{ color: "var(--ink-hi)" }}>{e.actorEmail ?? "A staff member"}</strong>
              <span>{ACTION_LABEL[e.action] ?? e.action}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}>{timeAgo(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
