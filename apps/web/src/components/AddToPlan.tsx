/**
 * AddToPlan — "add this venue to one of my plans".
 *
 * Two entry points share ONE picker body (PlanPickerBody):
 *   - AddToPlan: the venue page's full-width "＋ Add to Plan" button → an inline popover.
 *   - AddToPlanIconButton: a compact icon on an Explore venue card → a portal MODAL. A card
 *     is an overflow:hidden <Card> that also transforms on hover, so an inline popover would
 *     be clipped/mispositioned — the modal is portalled to <body> to escape both.
 *
 * Signed out, both nudge sign-in rather than gating. Adds are idempotent (plans.addVenue).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

interface PlanRow {
  id: string;
  title: string;
  venueCount: number;
}

/* ── The shared picker body (authenticated): load my plans, add this venue to any, or spin up
 *    a new plan. Loads on mount, so it fetches when the popover/modal opens (both mount it
 *    only when shown). ────────────────────────────────────────────────────────────────────── */
function PlanPickerBody({ venueId }: { venueId: string }) {
  const t = useTranslations("addToPlan");
  const trpc = useTrpc();
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

  useEffect(() => {
    void loadPlans().catch(() => setPlans([]));
  }, [loadPlans]);

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
    [trpc, venueId, t],
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
  }, [trpc, newTitle, addTo, loadPlans, t]);

  return (
    <>
      <div style={pickerLabel}>{t("addToAPlan")}</div>

      {plans === undefined ? (
        <div style={{ height: 36, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
      ) : plans.length === 0 ? (
        <p style={{ margin: "0 0 var(--space-2)", fontSize: 13, color: "var(--ink-2)" }}>{t("empty")}</p>
      ) : (
        <div style={{ display: "grid", gap: 2, marginBottom: "var(--space-2)", maxHeight: 200, overflowY: "auto" }}>
          {plans.map((p) => {
            const done = added.has(p.id);
            return (
              <button key={p.id} type="button" onClick={() => void addTo(p.id)} disabled={done} style={{ ...planRowBtn, cursor: done ? "default" : "pointer" }}>
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
          style={newPlanInput}
        />
        <Button variant="pri" size="sm" onClick={() => void createAndAdd()} disabled={newTitle.trim().length === 0 || busy}>
          {busy ? "…" : t("add")}
        </Button>
      </div>

      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 12, marginTop: 6 }}>{err}</div> : null}
    </>
  );
}

/* ── Venue page: full-width button → inline popover. ──────────────────────────────────────── */
export function AddToPlan({ venueId, block = false }: { venueId: string; block?: boolean }) {
  const t = useTranslations("addToPlan");
  const session = useSession();
  const [open, setOpen] = useState(false);

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
      <Button variant="neutral" block={block} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {t("addToPlan")}
      </Button>
      {open ? (
        <Card style={{ position: "absolute", zIndex: 30, marginTop: 6, width: 280, maxWidth: "90vw", padding: "var(--space-3)", boxShadow: "var(--shadow-pop)" }}>
          <PlanPickerBody venueId={venueId} />
        </Card>
      ) : null}
    </div>
  );
}

/* ── Explore card: compact icon → portal modal (escapes the card's overflow + hover transform).
 *    The trigger lives inside the card's <Link>, so it isolates its own click; the modal is
 *    portalled to <body>, outside the Link, so its own clicks (incl. the sign-in Link) are safe. */
export function AddToPlanIconButton({ venueId }: { venueId: string }) {
  const t = useTranslations("addToPlan");
  const session = useSession();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const onTrigger = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  }, []);

  return (
    <>
      <button type="button" aria-label={t("addToPlan")} title={t("addToPlan")} onClick={onTrigger} style={iconTrigger}>
        <Icon name="plan" size={17} />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div role="dialog" aria-modal="true" onClick={close} style={modalScrim}>
              <Card onClick={(e) => e.stopPropagation()} style={modalCard}>
                <div style={modalHead}>
                  <span style={pickerLabel}>{t("addToAPlan")}</span>
                  <button type="button" aria-label={t("close")} onClick={close} style={closeBtn}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
                {session ? (
                  <PlanPickerBody venueId={venueId} />
                ) : (
                  <div style={{ paddingTop: "var(--space-1)" }}>
                    <p style={{ margin: "0 0 var(--space-3)", fontSize: 14, color: "var(--ink-2)" }}>{t("signInTitle")}</p>
                    <Link href="/account" style={{ textDecoration: "none" }}>
                      <Button variant="pri" size="sm">{t("signIn")}</Button>
                    </Link>
                  </div>
                )}
              </Card>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ── styles ───────────────────────────────────────────────────────────────────────────────── */
import type { CSSProperties } from "react";

const pickerLabel: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "var(--space-2)",
};

const planRowBtn: CSSProperties = {
  all: "unset",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "8px 10px",
  borderRadius: "var(--r-md)",
  fontSize: 13.5,
  color: "var(--ink)",
};

const newPlanInput: CSSProperties = {
  flex: 1,
  boxSizing: "border-box",
  padding: "8px 10px",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16,
  color: "var(--ink)",
  outline: "none",
};

const iconTrigger: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 8,
  color: "var(--muted)",
  background: "var(--paper-2)",
};

const modalScrim: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 300,
  display: "grid",
  placeItems: "center",
  background: "rgba(33,29,26,.55)",
  padding: "var(--space-4)",
};

const modalCard: CSSProperties = {
  width: 320,
  maxWidth: "100%",
  padding: "var(--space-4)",
  boxShadow: "var(--shadow-pop)",
};

const modalHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const closeBtn: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "inline-flex",
  padding: 4,
  borderRadius: 6,
  color: "var(--muted)",
  marginTop: -4,
  marginBottom: "var(--space-2)",
};
