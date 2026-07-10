/**
 * AddToPlan — the venue page's "＋ Add to Plan" control, now live. Signed in, it opens a small
 * panel listing your plans (tap to add this venue) plus a quick "New plan" row. Signed out, it
 * nudges sign-in rather than gating the page. Adds are idempotent (plans.addVenue upserts).
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

interface PlanRow {
  id: string;
  title: string;
  venueCount: number;
}

export function AddToPlan({ venueId, block = false }: { venueId: string; block?: boolean }) {
  const t = useTranslations("addToPlan");
  const trpc = useTrpc();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<PlanRow[] | undefined>(undefined);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadPlans = useCallback(async () => {
    const list = trpc.plans.list as unknown as { query: () => Promise<{ plans: PlanRow[] }> };
    const res = await list.query();
    setPlans(res.plans ?? []);
  }, [trpc]);

  const onToggleOpen = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      if (next && plans === undefined) void loadPlans().catch(() => setPlans([]));
      return next;
    });
  }, [plans, loadPlans]);

  const addTo = useCallback(
    async (planId: string) => {
      setErr(null);
      const addVenue = trpc.plans.addVenue as unknown as { mutate: (i: { planId: string; venueId: string }) => Promise<{ ok: true }> };
      try {
        await addVenue.mutate({ planId, venueId });
        setAdded((s) => new Set(s).add(planId));
      } catch (e) {
        setErr(e instanceof Error ? e.message : t("errors.add"));
      }
    },
    [trpc, venueId],
  );

  const createAndAdd = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    setErr(null);
    const create = trpc.plans.create as unknown as { mutate: (i: { title: string }) => Promise<{ id: string }> };
    try {
      const { id } = await create.mutate({ title });
      await addTo(id);
      setNewTitle("");
      await loadPlans();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("errors.create"));
    } finally {
      setBusy(false);
    }
  }, [trpc, newTitle, addTo, loadPlans]);

  // Signed out: a quiet nudge.
  if (!session) {
    return (
      <Link href="/account" style={{ textDecoration: "none", ...(block ? { display: "block" } : {}) }}>
        <Button variant="neutral" block={block} title={t("signInTitle")}>
          {t("addToPlan")}
        </Button>
      </Link>
    );
  }

  return (
    <div style={{ position: "relative", ...(block ? { width: "100%" } : {}) }}>
      <Button variant="neutral" block={block} onClick={onToggleOpen} aria-expanded={open}>
        {t("addToPlan")}
      </Button>

      {open ? (
        <Card style={{ position: "absolute", zIndex: 30, marginTop: 6, width: 280, maxWidth: "90vw", padding: "var(--space-3)", boxShadow: "var(--shadow-pop)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
            {t("addToAPlan")}
          </div>

          {plans === undefined ? (
            <div style={{ height: 36, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
          ) : plans.length === 0 ? (
            <p style={{ margin: "0 0 var(--space-2)", fontSize: 13, color: "var(--ink-2)" }}>{t("empty")}</p>
          ) : (
            <div style={{ display: "grid", gap: 2, marginBottom: "var(--space-2)", maxHeight: 200, overflowY: "auto" }}>
              {plans.map((p) => {
                const done = added.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void addTo(p.id)}
                    disabled={done}
                    style={{
                      all: "unset",
                      cursor: done ? "default" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: "var(--r-md)",
                      fontSize: 13.5,
                      color: "var(--ink)",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                    <span style={{ fontSize: 12, color: done ? "var(--success)" : "var(--crimson-700)", fontWeight: 600, flexShrink: 0 }}>
                      {done ? t("added") : t("add")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ display: "flex", gap: 6, borderTop: "1px solid var(--line)", paddingTop: "var(--space-2)" }}>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t("newPlanPlaceholder")}
              aria-label={t("newPlanAria")}
              maxLength={120}
              style={{ flex: 1, boxSizing: "border-box", padding: "8px 10px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none" }}
            />
            <Button variant="pri" size="sm" onClick={() => void createAndAdd()} disabled={newTitle.trim().length === 0 || busy}>
              {busy ? "…" : t("add")}
            </Button>
          </div>

          {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 12, marginTop: 6 }}>{err}</div> : null}
        </Card>
      ) : null}
    </div>
  );
}
