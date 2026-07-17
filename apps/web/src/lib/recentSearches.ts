/**
 * Recent searches — the last few queries a user ran, kept in localStorage so the search dropdown
 * can offer them before you type (like Facebook). Per-device, signed-out-friendly (no round-trip),
 * capped and de-duped most-recent-first. Same storage idiom as savedPlaces/currentPlace.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "roam:recent-searches";
const MAX = 6;
/** Fired on window after a local write so other hook instances in this tab update immediately. */
const CHANGE_EVENT = "roam:recent-searches-changed";

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX)));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* private mode / quota — recents are best-effort */
  }
}

export interface RecentSearchesStore {
  recent: string[];
  /** Record a query at the top (de-duped, case-insensitively), trimming to the cap. */
  add: (q: string) => void;
  /** Remove one query. */
  remove: (q: string) => void;
  /** Clear all. */
  clear: () => void;
}

export function useRecentSearches(): RecentSearchesStore {
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    setRecent(read());
    const onChange = () => setRecent(read());
    window.addEventListener("storage", onChange);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const add = useCallback((q: string) => {
    const term = q.trim();
    if (term.length < 2) return;
    const next = [term, ...read().filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, MAX);
    write(next);
    setRecent(next);
  }, []);

  const remove = useCallback((q: string) => {
    const next = read().filter((r) => r.toLowerCase() !== q.toLowerCase());
    write(next);
    setRecent(next);
  }, []);

  const clear = useCallback(() => {
    write([]);
    setRecent([]);
  }, []);

  return { recent, add, remove, clear };
}
