/**
 * homeLayout — the user's personalised Home dashboard order + which widgets they've hidden.
 *
 * The Home page renders a fixed set of widgets (recent chats, plans, your town, …). This module
 * lets a user REORDER them and HIDE the ones they don't use. The preference is per-device, stored
 * in localStorage (works for signed-out browsers too, no migration needed); the pure reducers
 * below are deliberately storage-agnostic so a future server-synced version (cross-device) can
 * reuse them unchanged.
 *
 * Model: `order` is the full list of widget ids top→bottom; `hidden` is the subset the user has
 * switched off. Reorder/hide operate over the widgets APPLICABLE to the current context (e.g. the
 * transit widget only exists inside Ireland), so moving "up" swaps with the neighbour the user
 * actually sees — non-applicable ids keep their slot untouched.
 */

import { useCallback, useEffect, useState } from "react";

export interface HomeLayout {
  /** All widget ids, top → bottom. */
  order: string[];
  /** Widget ids the user has hidden (still in `order`, just not rendered). */
  hidden: string[];
}

const STORAGE_KEY = "roam.home.layout.v1";

/** The out-of-the-box layout for a registry: registry order, nothing hidden. */
export function defaultLayout(registryIds: readonly string[]): HomeLayout {
  return { order: [...registryIds], hidden: [] };
}

/**
 * Reconcile a stored layout against the canonical registry: drop ids that no longer exist, keep
 * the user's order, and APPEND any registry ids they've never seen (widgets shipped since they
 * last saved) in registry order — so new features always surface and removed ones vanish cleanly.
 */
export function reconcile(
  stored: Partial<HomeLayout> | null | undefined,
  registryIds: readonly string[],
): HomeLayout {
  const known = new Set(registryIds);
  const order = (stored?.order ?? []).filter((id) => known.has(id));
  const seen = new Set(order);
  for (const id of registryIds) if (!seen.has(id)) order.push(id);
  const hidden = (stored?.hidden ?? []).filter((id) => known.has(id));
  return { order, hidden };
}

/**
 * Move a widget one step up (-1) or down (+1) AMONG the orderable ids (the widgets applicable to
 * the current context — defaults to the whole order). Non-orderable ids keep their positions; we
 * swap the widget with its neighbour within the applicable projection, then splice the reordered
 * projection back into the full order. A no-op at the ends or for an unknown id.
 */
export function moveWidget(
  layout: HomeLayout,
  id: string,
  dir: -1 | 1,
  orderable?: readonly string[],
): HomeLayout {
  const scope = orderable ? layout.order.filter((x) => orderable.includes(x)) : [...layout.order];
  const i = scope.indexOf(id);
  if (i < 0) return layout;
  const j = i + dir;
  if (j < 0 || j >= scope.length) return layout;
  const a = scope[i];
  const b = scope[j];
  if (a === undefined || b === undefined) return layout;
  scope[i] = b;
  scope[j] = a;
  // Rebuild the full order: walk it, refilling the applicable slots from the reordered scope.
  const inScope = new Set(scope);
  let k = 0;
  const order = layout.order.map((x) => (inScope.has(x) ? (scope[k++] as string) : x));
  return { ...layout, order };
}

/** Toggle a widget's hidden state. */
export function toggleHidden(layout: HomeLayout, id: string): HomeLayout {
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter((h) => h !== id)
    : [...layout.hidden, id];
  return { ...layout, hidden };
}

/**
 * React hook: load the layout from localStorage (once, client-side to avoid a hydration
 * mismatch), reconcile it against the registry, and persist on every change. Returns the layout
 * plus stable action callbacks. `registryIds` must be a stable module constant.
 */
export function useHomeLayout(registryIds: readonly string[]) {
  const [layout, setLayout] = useState<HomeLayout>(() => defaultLayout(registryIds));
  const [loaded, setLoaded] = useState(false);

  // Server + first client render use the DEFAULT order (deterministic, no mismatch); once mounted
  // we swap in the stored order. A brief flash of default order for customised users is the price
  // of never throwing a hydration error.
  useEffect(() => {
    let next: HomeLayout;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      next = reconcile(raw ? (JSON.parse(raw) as Partial<HomeLayout>) : null, registryIds);
    } catch {
      next = defaultLayout(registryIds);
    }
    setLayout(next);
    setLoaded(true);
    // registryIds is a stable module constant — intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist only AFTER the initial load, so we never clobber a saved layout with the default.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* storage full / disabled — layout stays in memory for this session */
    }
  }, [layout, loaded]);

  const move = useCallback(
    (id: string, dir: -1 | 1, orderable?: readonly string[]) =>
      setLayout((l) => moveWidget(l, id, dir, orderable)),
    [],
  );
  const toggle = useCallback((id: string) => setLayout((l) => toggleHidden(l, id)), []);
  const reset = useCallback(() => setLayout(defaultLayout(registryIds)), [registryIds]);

  return { layout, loaded, move, toggle, reset };
}
