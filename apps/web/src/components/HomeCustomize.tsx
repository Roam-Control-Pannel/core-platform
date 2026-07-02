/**
 * HomeCustomize — the "Customise home" editor sheet.
 *
 * A focused overlay (mirrors AuthModal's plumbing: scrim, centred card, Escape / click-outside to
 * close, body-scroll lock, focus moved in) that lists the Home widgets in their current order and
 * lets the user REORDER them (up / down) and SHOW/HIDE each one. Deliberately NOT drag-and-drop:
 * arrows + toggles are touch-friendly and accessible on a mobile-first app. Edits apply live to
 * the dashboard behind the sheet; a Reset restores the default order.
 */
"use client";

import { useEffect, useRef } from "react";
import { Icon } from "@roam/design";

export interface CustomizeItem {
  id: string;
  label: string;
  hidden: boolean;
}

export function HomeCustomize({
  open,
  onClose,
  items,
  onMove,
  onToggle,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  /** Applicable widgets in current display order (top → bottom). */
  items: CustomizeItem[];
  onMove: (id: string, dir: -1 | 1) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevFocus = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Customise home"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "start center",
        padding: "var(--space-8) var(--space-3)",
        background: "rgba(20, 14, 16, 0.55)",
        overflowY: "auto",
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          outline: "none",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 18,
          boxShadow: "var(--shadow-pop)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
            padding: "var(--space-4)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div>
            <h2
              className="t-h3"
              style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: 0 }}
            >
              Customise home
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--ink-2)" }}>
              Reorder or hide the sections you see.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Done"
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "8px 14px",
              minHeight: 40,
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 999,
              background: "var(--ink-hi)",
              color: "#fff",
              fontFamily: "var(--ui)",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            Done
          </button>
        </header>

        <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-2)", display: "grid", gap: 2 }}>
          {items.map((it, i) => (
            <li
              key={it.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "var(--space-2)",
                borderRadius: 12,
                opacity: it.hidden ? 0.55 : 1,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--ui)",
                  fontSize: 14.5,
                  fontWeight: 600,
                  color: "var(--ink)",
                  textDecoration: it.hidden ? "line-through" : "none",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {it.label}
              </span>

              <IconBtn
                label={`Move ${it.label} up`}
                disabled={i === 0}
                onClick={() => onMove(it.id, -1)}
              >
                ↑
              </IconBtn>
              <IconBtn
                label={`Move ${it.label} down`}
                disabled={i === items.length - 1}
                onClick={() => onMove(it.id, 1)}
              >
                ↓
              </IconBtn>
              <IconBtn
                label={it.hidden ? `Show ${it.label}` : `Hide ${it.label}`}
                onClick={() => onToggle(it.id)}
                active={!it.hidden}
              >
                <Icon name={it.hidden ? "eyeOff" : "eye"} size={18} />
              </IconBtn>
            </li>
          ))}
        </ul>

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-start",
            padding: "var(--space-3) var(--space-4)",
            borderTop: "1px solid var(--line)",
          }}
        >
          <button
            onClick={onReset}
            style={{
              all: "unset",
              cursor: "pointer",
              minHeight: 40,
              display: "inline-flex",
              alignItems: "center",
              padding: "0 4px",
              fontFamily: "var(--ui)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink-2)",
            }}
          >
            Reset to default
          </button>
        </footer>
      </div>
    </div>
  );
}

/** A square ≥44px tap-target icon button used for the up / down / hide controls. */
function IconBtn({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        all: "unset",
        boxSizing: "border-box",
        width: 44,
        height: 44,
        display: "grid",
        placeItems: "center",
        borderRadius: 10,
        cursor: disabled ? "default" : "pointer",
        border: "1px solid var(--line)",
        background: active ? "var(--crimson-tint)" : "var(--paper-2)",
        color: disabled ? "var(--faint)" : "var(--ink-2)",
        fontSize: 16,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}
