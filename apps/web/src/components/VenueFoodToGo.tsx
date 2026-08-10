/**
 * VenueFoodToGo — the owner's "go live on Food to Go" surface (dashboard tab).
 *
 * One place a vendor stands up their F2G presence: a master list/unlist switch (tags the venue
 * into the f2g channel via channels.tagVenue), a readiness checklist (f2g.listingStatus — claimed,
 * listed, live menu item, payments on, collection on), and the order-ahead & collect settings form
 * (f2g.collectionSettings / setCollectionSettings). The menu itself lives on the Shop tab and the
 * checklist links there; nothing is duplicated.
 *
 * The whole tab is gated by the marketplace.f2g.enabled flag upstream (VenueOwnerEditor), so this
 * only renders once the feature is switched on.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

type ChecklistKey =
  | "claimed"
  | "tagged"
  | "hasActiveProduct"
  | "paymentsEnabled"
  | "collectionConfigured";

interface ListingStatus {
  claimed: boolean;
  tagged: boolean;
  hasActiveProduct: boolean;
  paymentsEnabled: boolean;
  collectionConfigured: boolean;
  ready: boolean;
  missing: ChecklistKey[];
}

interface CollectionSettings {
  orderAhead: boolean;
  paused: boolean;
  prepTimeMins: number;
  collectionInstructions: string | null;
}

const CHECKLIST_ORDER: ChecklistKey[] = [
  "claimed",
  "tagged",
  "hasActiveProduct",
  "paymentsEnabled",
  "collectionConfigured",
];

export function VenueFoodToGo({
  venueId,
  onNavigate,
}: {
  venueId: string;
  onNavigate: (tab: "shop") => void;
}) {
  const t = useTranslations("venueOwnerEditor.foodToGo");
  const trpc = useTrpc();
  const [status, setStatus] = useState<ListingStatus | null>(null);
  const [settings, setSettings] = useState<CollectionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);

  const reload = useCallback(async () => {
    const [s, c] = await Promise.all([
      trpc.f2g.listingStatus.query({ venueId }),
      trpc.f2g.collectionSettings.query({ venueId }),
    ]);
    setStatus(s as ListingStatus);
    setSettings(c as CollectionSettings);
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    reload().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load.");
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const toggleListing = useCallback(async () => {
    if (!status) return;
    setListBusy(true);
    setError(null);
    try {
      if (status.tagged) {
        await trpc.channels.untagVenue.mutate({ venueId, channelKey: "f2g" });
      } else {
        await trpc.channels.tagVenue.mutate({ venueId, channelKey: "f2g" });
      }
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update listing.");
    } finally {
      setListBusy(false);
    }
  }, [status, trpc, venueId, reload]);

  if (error && !status) {
    return (
      <p role="alert" style={{ color: "var(--crimson-700)", fontSize: 14 }}>
        {error}
      </p>
    );
  }
  if (!status || !settings) {
    return <div style={{ height: 320, borderRadius: 20, background: "var(--paper-2)" }} aria-hidden />;
  }

  const stepsLeft = status.missing.length;

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {/* Status hero */}
      <Card style={{ padding: "var(--space-4) var(--space-5)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span
            aria-hidden
            style={{
              display: "grid",
              placeItems: "center",
              width: 44,
              height: 44,
              borderRadius: 14,
              flexShrink: 0,
              background: status.ready ? "var(--success-tint)" : "var(--crimson-tint)",
              color: status.ready ? "var(--success)" : "var(--crimson-700)",
            }}
          >
            <Icon name={status.ready ? "check" : "shop"} size={22} strokeWidth={status.ready ? 3 : 2} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: 0 }}>
              {status.ready ? t("status.readyTitle") : t("status.notReadyTitle", { count: stepsLeft })}
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45 }}>
              {status.ready ? t("status.readySubtitle") : t("status.notReadySubtitle")}
            </p>
          </div>
        </div>
      </Card>

      {/* Master list / unlist switch */}
      <Card style={{ padding: "var(--space-4) var(--space-5)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 15 }}>{t("listing.title")}</strong>
              <StateChip on={status.tagged} onLabel={t("listing.on")} offLabel={t("listing.off")} />
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>
              {t("listing.description")}
            </p>
          </div>
          <Button
            variant={status.tagged ? "neutral" : "pri"}
            onClick={toggleListing}
            disabled={listBusy}
          >
            {listBusy
              ? t("listing.working")
              : status.tagged
                ? t("listing.unlistCta")
                : t("listing.listCta")}
          </Button>
        </div>
      </Card>

      {/* Readiness checklist */}
      <Card style={{ padding: "var(--space-4) var(--space-5)" }}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
          {CHECKLIST_ORDER.map((key) => (
            <ChecklistRow
              key={key}
              done={status[key]}
              label={t(`checklist.${key}`)}
              action={
                !status[key] && key === "hasActiveProduct"
                  ? { label: t("checklist.fixMenu"), onClick: () => onNavigate("shop") }
                  : !status[key] && key === "paymentsEnabled"
                    ? { label: t("checklist.fixPayments"), onClick: () => onNavigate("shop") }
                    : undefined
              }
            />
          ))}
        </ul>
      </Card>

      {/* Collection settings */}
      <Card style={{ padding: "var(--space-4) var(--space-5)" }}>
        <header style={{ marginBottom: "var(--space-4)" }}>
          <h3 style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>
            {t("collection.title")}
          </h3>
          <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>
            {t("collection.subtitle")}
          </p>
        </header>
        <CollectionForm
          venueId={venueId}
          initial={settings}
          onSaved={(next) => {
            setSettings(next);
            void reload();
          }}
        />
      </Card>
    </div>
  );
}

/* ── Collection settings form ─────────────────────────────────────────────────────────── */

function CollectionForm({
  venueId,
  initial,
  onSaved,
}: {
  venueId: string;
  initial: CollectionSettings;
  onSaved: (next: CollectionSettings) => void;
}) {
  const t = useTranslations("venueOwnerEditor.foodToGo");
  const trpc = useTrpc();
  const [orderAhead, setOrderAhead] = useState(initial.orderAhead);
  const [paused, setPaused] = useState(initial.paused);
  const [prep, setPrep] = useState(String(initial.prepTimeMins));
  const [instructions, setInstructions] = useState(initial.collectionInstructions ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    const prepMins = Math.min(240, Math.max(0, Math.round(Number(prep) || 0)));
    try {
      const res = await trpc.f2g.setCollectionSettings.mutate({
        venueId,
        orderAhead,
        paused,
        prepTimeMins: prepMins,
        collectionInstructions: instructions.trim() ? instructions.trim() : null,
      });
      onSaved(res.settings as CollectionSettings);
      setPrep(String(res.settings.prepTimeMins));
      setSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("collection.error"));
    } finally {
      setSaving(false);
    }
  }, [trpc, venueId, orderAhead, paused, prep, instructions, onSaved, t]);

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <ToggleRow
        label={t("collection.orderAhead")}
        hint={t("collection.orderAheadHint")}
        on={orderAhead}
        onToggle={() => {
          setOrderAhead((v) => !v);
          setSaved(false);
        }}
      />
      <ToggleRow
        label={t("collection.paused")}
        hint={t("collection.pausedHint")}
        on={paused}
        onToggle={() => {
          setPaused((v) => !v);
          setSaved(false);
        }}
      />

      <div>
        <label style={labelStyle} htmlFor="f2g-prep">
          {t("collection.prepTime")}
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            id="f2g-prep"
            inputMode="numeric"
            value={prep}
            onChange={(e) => {
              setPrep(e.target.value.replace(/[^\d]/g, "").slice(0, 3));
              setSaved(false);
            }}
            style={{ ...field, width: 96 }}
          />
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{t("collection.prepTimeUnit")}</span>
        </div>
        <p style={hintStyle}>{t("collection.prepTimeHint", { mins: Math.max(0, Math.round(Number(prep) || 0)) })}</p>
      </div>

      <div>
        <label style={labelStyle} htmlFor="f2g-instructions">
          {t("collection.instructions")}
        </label>
        <textarea
          id="f2g-instructions"
          value={instructions}
          maxLength={500}
          placeholder={t("collection.instructionsPlaceholder")}
          onChange={(e) => {
            setInstructions(e.target.value);
            setSaved(false);
          }}
          rows={2}
          style={{ ...field, resize: "vertical", minHeight: 56 }}
        />
        <p style={hintStyle}>{t("collection.instructionsHint")}</p>
      </div>

      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--crimson-700)" }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <Button variant="pri" onClick={save} disabled={saving}>
          {saving ? t("collection.saving") : t("collection.save")}
        </Button>
        {saved ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "var(--success)" }}>
            <Icon name="check" size={14} strokeWidth={3} /> {t("collection.saved")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ── Small building blocks ────────────────────────────────────────────────────────────── */

function ChecklistRow({
  done,
  label,
  action,
}: {
  done: boolean;
  label: string;
  action?: { label: string; onClick: () => void } | undefined;
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "10px 4px",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 24,
          height: 24,
          borderRadius: 999,
          flexShrink: 0,
          background: done ? "var(--success-tint)" : "var(--paper-2)",
          color: done ? "var(--success)" : "var(--faint)",
        }}
      >
        <Icon name={done ? "check" : "clock"} size={14} strokeWidth={done ? 3 : 2} />
      </span>
      <span style={{ flex: 1, fontSize: 14, color: done ? "var(--ink)" : "var(--ink-2)" }}>{label}</span>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            all: "unset",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--crimson-700)",
            whiteSpace: "nowrap",
          }}
        >
          {action.label} <span aria-hidden>→</span>
        </button>
      ) : null}
    </li>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)" }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
        <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.4 }}>{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        style={{
          all: "unset",
          cursor: "pointer",
          flexShrink: 0,
          width: 44,
          height: 26,
          borderRadius: 999,
          background: on ? "var(--crimson)" : "var(--line-2)",
          position: "relative",
          transition: "background .15s ease",
        }}
      >
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 3,
            left: on ? 21 : 3,
            width: 20,
            height: 20,
            borderRadius: 999,
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,.25)",
            transition: "left .15s ease",
          }}
        />
      </button>
    </div>
  );
}

function StateChip({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 9px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: on ? "var(--success)" : "var(--muted)",
        background: on ? "var(--success-tint)" : "var(--paper-2)",
      }}
    >
      {on ? onLabel : offLabel}
    </span>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--ink-2)",
  marginBottom: 6,
};

const hintStyle: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  color: "var(--muted)",
  lineHeight: 1.4,
};

const field: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "var(--ui)",
  color: "var(--ink)",
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  outline: "none",
};
