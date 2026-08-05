/**
 * Audit trail — the privileged-action log (adminActivity.auditLog): who did what, when.
 * Every HQ action writes a row here, attributed to the acting staff member. Read-only.
 */
"use client";

import { useEffect, useState } from "react";
import { useTrpc } from "../TrpcProvider";
import { C, F } from "../../theme";
import { ErrorLine, Kicker, Panel, SkeletonBlock, timeAgo } from "../ui";

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

export function AuditView() {
  const trpc = useTrpc();
  const [entries, setEntries] = useState<AuditEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminActivity.auditLog.query({ limit: 50 }) as Promise<AuditEntry[]>)
      .then((d) => !cancelled && setEntries(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load audit log."));
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <header>
        <Kicker>Roam · Internal</Kicker>
        <h1 style={{ fontFamily: F.display, fontWeight: 700, fontSize: 40, letterSpacing: "-.03em", margin: "2px 0 0" }}>Audit trail</h1>
      </header>

      {error ? <ErrorLine message={error} /> : !entries ? (
        <div style={{ display: "grid", gap: 8 }}>{Array.from({ length: 6 }).map((_, i) => <SkeletonBlock key={i} height={40} />)}</div>
      ) : entries.length === 0 ? (
        <Panel style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, marginBottom: 6 }}>No actions yet</div>
          <div style={{ color: C.muted, fontSize: 14 }}>Privileged actions will appear here as staff take them.</div>
        </Panel>
      ) : (
        <Panel style={{ padding: "8px 24px" }}>
          {entries.map((e, i) => {
            const decision = typeof e.detail?.decision === "string" ? ` (${e.detail.decision})` : "";
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "13px 0", borderTop: i === 0 ? "none" : `1px solid ${C.line}` }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.inkSoft }}>
                  <strong style={{ color: C.ink }}>{e.actorEmail ?? "A staff member"}</strong> {ACTION_LABEL[e.action] ?? e.action}{decision}
                  {e.entityType ? <span style={{ color: C.muted }}> · {e.entityType}</span> : null}
                </span>
                <span style={{ fontFamily: F.mono, fontSize: 11, color: C.faint, whiteSpace: "nowrap" }}>{timeAgo(e.createdAt)}</span>
              </div>
            );
          })}
        </Panel>
      )}
    </div>
  );
}
