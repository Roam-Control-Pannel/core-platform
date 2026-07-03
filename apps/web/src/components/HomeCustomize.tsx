/**
 * HomeCustomize — the "Customise home" editor sheet.
 *
 * A focused overlay (mirrors AuthModal's plumbing: scrim, centred card, Escape / click-outside to
 * close, body-scroll lock, focus moved in) that lists the Home widgets in their current order and
 * lets the user REORDER them by DRAG-AND-DROP and SHOW/HIDE each one. Each row has a grip handle:
 * drag it (pointer events — works with mouse and touch) to move the widget, and the list
 * live-reorders under the pointer, committing on drop. The same handle is keyboard-operable
 * (focus it, Arrow Up/Down to move a step) so reordering stays accessible without a pointer.
 * Edits apply live to the dashboard behind the sheet; a Reset restores the default order.
 */
"use client";

import { useEffect, useRef, useState } from "react";
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
  onReorder,
  onToggle,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  /** Applicable widgets in current display order (top → bottom). */
  items: CustomizeItem[];
  /** One-step move (keyboard arrows on the handle). */
  onMove: (id: string, dir: -1 | 1) => void;
  /** Drop a widget at an absolute index within the applicable list (drag-and-drop). */
  onReorder: (id: string, toIndex: number) => void;
  onToggle: (id: string) => void;
  onReset: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Local working copy so the list can live-reorder under the pointer during a drag; it syncs from
  // props whenever we're not mid-drag (props are the committed source of truth).
  const [working, setWorking] = useState<CustomizeItem[]>(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const workingRef = useRef(working);
  workingRef.current = working;

  useEffect(() => {
    if (!dragId) setWorking(items);
  }, [items, dragId]);

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

  // ── Drag mechanics (pointer events: mouse + touch) ──────────────────────────────────────────
  const beginDrag = (e: React.PointerEvent, id: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // primary button / any touch only
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragIdRef.current = id;
    setDragId(id);
  };

  const onDragMove = (e: React.PointerEvent) => {
    const id = dragIdRef.current;
    if (!id || !listRef.current) return;
    e.preventDefault(); // stop touch-scroll while dragging
    const y = e.clientY;
    const rows = Array.from(listRef.current.querySelectorAll<HTMLLIElement>("[data-row]"));
    // Target = the first row whose vertical midpoint sits below the pointer (else the last row).
    let target = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        target = i;
        break;
      }
    }
    setWorking((cur) => {
      const from = cur.findIndex((x) => x.id === id);
      if (from < 0 || from === target) return cur;
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved as CustomizeItem);
      return next;
    });
  };

  const endDrag = () => {
    const id = dragIdRef.current;
    dragIdRef.current = null;
    setDragId(null);
    if (!id) return;
    const toIndex = workingRef.current.findIndex((x) => x.id === id);
    if (toIndex >= 0) onReorder(id, toIndex);
  };

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
              Drag the handle to reorder, or hide the sections you see.
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

        <ul ref={listRef} style={{ listStyle: "none", margin: 0, padding: "var(--space-2)", display: "grid", gap: 2 }}>
          {working.map((it) => {
            const dragging = dragId === it.id;
            return (
              <li
                key={it.id}
                data-row
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  padding: "var(--space-2)",
                  borderRadius: 12,
                  opacity: it.hidden && !dragging ? 0.55 : 1,
                  background: dragging ? "var(--paper-2)" : "transparent",
                  boxShadow: dragging ? "var(--shadow-pop)" : "none",
                  position: "relative",
                  zIndex: dragging ? 1 : 0,
                }}
              >
                <button
                  type="button"
                  aria-label={`Reorder ${it.label}`}
                  onPointerDown={(e) => beginDrag(e, it.id)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp") { e.preventDefault(); onMove(it.id, -1); }
                    else if (e.key === "ArrowDown") { e.preventDefault(); onMove(it.id, 1); }
                  }}
                  style={{
                    all: "unset",
                    boxSizing: "border-box",
                    width: 40,
                    height: 44,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 10,
                    cursor: dragging ? "grabbing" : "grab",
                    color: "var(--faint)",
                    touchAction: "none",
                  }}
                >
                  <Icon name="grip" size={18} />
                </button>

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

                <button
                  type="button"
                  aria-label={it.hidden ? `Show ${it.label}` : `Hide ${it.label}`}
                  onClick={() => onToggle(it.id)}
                  style={{
                    all: "unset",
                    boxSizing: "border-box",
                    width: 44,
                    height: 44,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 10,
                    cursor: "pointer",
                    border: "1px solid var(--line)",
                    background: it.hidden ? "var(--paper-2)" : "var(--crimson-tint)",
                    color: "var(--ink-2)",
                  }}
                >
                  <Icon name={it.hidden ? "eyeOff" : "eye"} size={18} />
                </button>
              </li>
            );
          })}
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
