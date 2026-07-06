/**
 * Basecamp — the dedicated widget page (/basecamp): every Home widget at FULL size in the old
 * dashboard grid (full/half spans), plus a quick-nav tile row to every surface. Home's rail
 * shows the top of this same layout; Basecamp is where you see everything and shape it —
 * Customise (drag-reorder + hide) lives here as the page's core experience.
 *
 * One SHARED layout: useHomeLayoutSync is the same hook Home uses (localStorage + server sync
 * to profiles.home_layout), so reordering here reorders the Home rail too, on every device.
 *
 * The page is deliberately a shell over the shared registry (HOME_WIDGETS): future widgets —
 * the marketplace, business-owner tools, more regional integrations like Translink — are new
 * registry entries and appear here automatically at their natural size.
 */
"use client";

import { Fragment, useMemo, useState } from "react";
import { Card, Button, Icon, type IconName } from "@roam/design";
import Link from "next/link";
import { useSession } from "./TrpcProvider";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { HOME_WIDGETS, HOME_WIDGET_IDS, type WidgetCtx, type HomeWidget } from "./Home";
import { useHomeLayoutSync } from "./useHomeLayoutSync";
import { HomeCustomize, type CustomizeItem } from "./HomeCustomize";
import styles from "./Home.module.css";

const NAV_TILES: { href: string; glyph: IconName; label: string }[] = [
  { href: "/explore", glyph: "search", label: "Explore" },
  { href: "/town-hall", glyph: "landmark", label: "Town Hall" },
  { href: "/plans", glyph: "plan", label: "Plans" },
  { href: "/threads", glyph: "chat", label: "Chat" },
  { href: "/deals", glyph: "ticket", label: "Deals" },
  { href: "/friends", glyph: "users", label: "Friends" },
];

export function Basecamp() {
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();
  const { layout, move, reorder, toggle, reset, flushLayout } = useHomeLayoutSync(HOME_WIDGET_IDS);
  const [customizing, setCustomizing] = useState(false);

  const byId = useMemo(() => new Map(HOME_WIDGETS.map((w) => [w.id, w])), []);

  // Widgets applicable to the current context (transit only inside Ireland), in the user's order.
  const applicable = useMemo(() => {
    const list: HomeWidget[] = [];
    for (const id of layout.order) {
      const w = byId.get(id);
      if (w && (!w.condition || w.condition(place))) list.push(w);
    }
    return list;
  }, [layout.order, byId, place]);
  const applicableIds = useMemo(() => applicable.map((w) => w.id), [applicable]);

  const ctx: WidgetCtx = { hasSession: !!session, place };
  const visible = applicable.filter((w) => !layout.hidden.includes(w.id));
  const customizeItems: CustomizeItem[] = applicable.map((w) => ({
    id: w.id,
    label: w.label,
    hidden: layout.hidden.includes(w.id),
  }));

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-2)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}>
          Basecamp
        </h1>
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)", color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.5 }}>
          <span>Your Roam, your way — everything in</span>
          <PlaceSwitcher value={place} onChange={setPlace} />
          <button
            type="button"
            onClick={() => setCustomizing(true)}
            className={styles.customize}
            aria-haspopup="dialog"
          >
            <Icon name="settings" size={14} /> Customise
          </button>
        </div>

        {/* Quick navigation — one tap to every surface. */}
        <div className={styles.qgrid}>
          {NAV_TILES.map((t) => (
            <Link key={t.href} href={t.href} className={styles.qcard}>
              <span className={styles.qtile} aria-hidden><Icon name={t.glyph} size={16} /></span>
              {t.label}
            </Link>
          ))}
        </div>
      </header>

      {visible.length === 0 ? (
        <Card style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>
            You&apos;ve hidden every widget.
          </p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Button onClick={() => setCustomizing(true)}>Customise Basecamp</Button>
          </div>
        </Card>
      ) : (
        <div className={styles.grid}>
          {visible.map((w) =>
            // Full-span widgets get a spanAll wrapper; half widgets render DIRECTLY (their Card is
            // the grid item) so a widget that renders null (e.g. Deals with nothing live) leaves
            // no empty cell.
            w.span === "full" ? (
              <div key={w.id} className={styles.spanAll}>
                {w.render(ctx)}
              </div>
            ) : (
              <Fragment key={w.id}>{w.render(ctx)}</Fragment>
            ),
          )}
        </div>
      )}

      <HomeCustomize
        open={customizing}
        onClose={() => { setCustomizing(false); flushLayout(); }}
        items={customizeItems}
        onMove={(id, dir) => move(id, dir, applicableIds)}
        onReorder={(id, toIndex) => reorder(id, toIndex, applicableIds)}
        onToggle={toggle}
        onReset={reset}
      />
    </main>
  );
}
