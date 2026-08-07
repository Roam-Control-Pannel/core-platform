/**
 * SaveStopButton — a star toggle to save/unsave a Translink stop. Renders nothing when signed out
 * (saving needs an account). Optimistic via useSavedStops, so the star flips instantly. Two sizes:
 * "chip" (a pill, for the widget header) and "action" (a full button, for the panel action row).
 */
"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useSavedStops, type StopRef } from "./useSavedStops";

export function SaveStopButton({ stop, variant = "chip" }: { stop: StopRef; variant?: "chip" | "action" }) {
  const t = useTranslations("nearbyDepartures");
  const { hasSession, isSaved, save, remove } = useSavedStops();
  if (!hasSession) return null;

  const saved = isSaved(stop.stopId);
  const label = saved ? t("saved") : t("save");
  const onClick = () => (saved ? void remove(stop.stopId) : void save(stop));

  if (variant === "action") {
    return (
      <button type="button" onClick={onClick} aria-pressed={saved} style={saved ? actionSaved : action}>
        <Icon name="star" size={14} aria-hidden />
        {label}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-pressed={saved} aria-label={label} title={label} style={saved ? chipSaved : chip}>
      <Icon name="star" size={12} aria-hidden />
      {label}
    </button>
  );
}

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flex: "0 0 auto",
  cursor: "pointer",
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: ".1em",
  textTransform: "uppercase",
  color: "var(--muted)",
  background: "transparent",
  border: "1px solid var(--line-2)",
  borderRadius: 999,
  padding: "3px 9px 3px 7px",
};

const chipSaved: React.CSSProperties = {
  ...chip,
  color: "var(--crimson-700)",
  borderColor: "var(--crimson-700)",
  background: "var(--crimson-tint)",
};

const action: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
  textDecoration: "none",
  fontFamily: "var(--ui)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "8px 14px",
};

const actionSaved: React.CSSProperties = {
  ...action,
  color: "var(--crimson-700)",
  background: "var(--crimson-tint)",
  border: "1px solid var(--crimson-700)",
};
