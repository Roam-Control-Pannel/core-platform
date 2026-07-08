/**
 * Wishlist — the Market's save-hearts, persisted per-device in localStorage (two id sets:
 * venue products and C2C listings). Deliberately device-local for v1: hearts work instantly,
 * signed-in or not, with zero backend; if saved items should follow an account later, this
 * is the single seam to sync (same pattern place prefs used before 0067). Same-tab hook
 * consistency via a custom event, storage event for other tabs — the savedPlaces idiom.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "roam:wishlist";
const EVENT = "roam:wishlist-changed";

export type WishKind = "product" | "listing";

interface Stored {
  product: string[];
  listing: string[];
}

function read(): Stored {
  if (typeof window === "undefined") return { product: [], listing: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : {};
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 500) : []);
    return { product: arr(parsed.product), listing: arr(parsed.listing) };
  } catch {
    return { product: [], listing: [] };
  }
}

function write(next: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — best-effort */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useWishlist(kind: WishKind): {
  saved: Set<string>;
  isSaved: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const [saved, setSaved] = useState<Set<string>>(new Set());

  useEffect(() => {
    const sync = () => setSaved(new Set(read()[kind]));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [kind]);

  const isSaved = useCallback((id: string) => saved.has(id), [saved]);

  const toggle = useCallback(
    (id: string) => {
      const all = read();
      const list = all[kind];
      all[kind] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      write(all);
    },
    [kind],
  );

  return { saved, isSaved, toggle };
}
