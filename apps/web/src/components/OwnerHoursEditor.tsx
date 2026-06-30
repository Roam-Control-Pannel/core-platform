/**
 * OwnerHoursEditor — the venue owner's opening-hours editing surface (Slice 8).
 *
 * Mounted by VenueDetail's ClaimedDetail ONLY when the viewer owns the venue (isOwner),
 * beside OwnerMediaManager and OwnerDetailsEditor. A non-owner never sees it; the public
 * OpeningHours render is unchanged for everyone.
 *
 * The structured twin of the Places-sourced weekdayDescriptions. The owner authors real
 * machine-readable hours — 7 days, each open or closed, with one or more time intervals
 * (split shifts, e.g. a lunch close). On save, the server (updateVenueHours) validates,
 * DERIVES the weekdayDescriptions display strings, stamps source:'owner', and persists.
 * The public OpeningHours reader then renders owner hours identically to Google's, AND
 * gains a live "Open now" pill because the structured periods exist.
 *
 * Clean-slate seeding: if the venue has no structured periods yet (a fresh claim, or a
 * Places venue carrying only free-text weekdayDescriptions), the editor opens with every
 * day closed, ready to fill in. We do NOT attempt to parse free-text Places strings back
 * into times — that guess would be unreliable and a wrong guess is worse than an empty
 * form. The existing Places strings keep rendering publicly until the owner saves.
 *
 * One write path: venues.updateVenueHours (protectedProcedure). The mutation builds its
 * patch from exactly { opening_times }, so it is structurally impossible to touch any
 * other venue column; RLS (venues_owner_update, 0004 + 0022 with-check) is the row gate;
 * the 0023 check constraint is the provenance backstop. On success we call onSaved() —
 * the page's loadVenue refetch — so the public render below updates from server truth
 * (the same reload-after-write discipline OwnerDetailsEditor + OwnerMediaManager use).
 *
 * Design system only: Card / Button from @roam/design, var(--*) tokens, native inputs
 * (the house style — the design system exports no form control). Native <input type="time">
 * gives a real platform time picker AND emits exactly the "HH:MM" 24h the server expects,
 * so there's no parsing layer. One crimson (variant="pri") CTA — Save hours.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

/** Day labels, Monday-first (index 0=Mon … 6=Sun) — matches the server's WEEKDAY_NAMES
 *  and the order Places emits weekdayDescriptions in for this region. */
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Mirror of the API caps (packages/api/src/venue-hours.ts VENUE_HOURS_LIMITS). The
 *  friendly first line; the server re-enforces them as the real boundary. */
const MAX_INTERVALS_PER_DAY = 3;

/** Default timezone for owner-edited venues. Stored explicitly so "open now" is correct;
 *  a picker can be added later when there are non-UK venues (the field exists already). */
const DEFAULT_TIMEZONE = "Europe/London";

/** A single open interval in local form state. */
interface IntervalDraft {
  key: string;
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

/** One day's editable state. */
interface DayDraft {
  day: number; // 0=Mon … 6=Sun
  closed: boolean;
  intervals: IntervalDraft[];
}

/** The structured period shape the venue carries (when owner-authored). */
interface PeriodInput {
  day: number;
  closed: boolean;
  intervals: { open: string; close: string }[];
}

/** Loosely-typed tRPC surface (the TS2589 dodge OwnerDetailsEditor + VenueDetail use). */
interface UpdateVenueHoursMutation {
  mutate: (input: {
    venueId: string;
    periods: PeriodInput[] | null;
    timezone: string;
  }) => Promise<{ ok: boolean }>;
}

/** A sensible default interval for a freshly-opened day. */
function defaultInterval(): IntervalDraft {
  return { key: crypto.randomUUID(), open: "09:00", close: "17:00" };
}

/** Build the 7-day draft from the venue's existing structured periods (if any).
 *  Clean slate (all closed) when there are no structured periods to seed from. */
function periodsToDrafts(periods: PeriodInput[] | null | undefined): DayDraft[] {
  const byDay = new Map<number, PeriodInput>();
  if (Array.isArray(periods)) {
    for (const p of periods) {
      if (p && typeof p.day === "number" && p.day >= 0 && p.day <= 6) byDay.set(p.day, p);
    }
  }
  const drafts: DayDraft[] = [];
  for (let day = 0; day < 7; day++) {
    const p = byDay.get(day);
    if (!p || p.closed || !Array.isArray(p.intervals) || p.intervals.length === 0) {
      drafts.push({ day, closed: true, intervals: [] });
    } else {
      drafts.push({
        day,
        closed: false,
        intervals: p.intervals.map((iv) => ({
          key: crypto.randomUUID(),
          open: typeof iv.open === "string" ? iv.open : "",
          close: typeof iv.close === "string" ? iv.close : "",
        })),
      });
    }
  }
  return drafts;
}

/** Per-interval client validation (server is the real boundary; this is fast UX).
 *  A closing time earlier than the opening time is a legal overnight interval (e.g. a bar
 *  open 18:00–02:00); only equal times (no duration) are rejected. */
function intervalIssue(iv: IntervalDraft): string | null {
  if (!iv.open || !iv.close) return "Add both an opening and closing time.";
  if (iv.open === iv.close) return "Opening and closing time can't be the same.";
  return null;
}

/** True when an interval closes after midnight (the next day) — close earlier than open. */
function isOvernight(iv: IntervalDraft): boolean {
  return Boolean(iv.open) && Boolean(iv.close) && iv.close < iv.open;
}

export function OwnerHoursEditor({
  venueId,
  initialPeriods,
  onSaved,
}: {
  venueId: string;
  initialPeriods: PeriodInput[] | null | undefined;
  onSaved: () => Promise<unknown> | void;
}) {
  const trpc = useTrpc();

  const [days, setDays] = useState<DayDraft[]>(() => periodsToDrafts(initialPeriods));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const toggleClosed = useCallback((day: number, closed: boolean) => {
    setDays((prev) =>
      prev.map((d) => {
        if (d.day !== day) return d;
        // Opening a previously-closed day seeds one default interval so the owner has a
        // row to edit rather than an empty open day (which the server treats as closed).
        if (!closed && d.intervals.length === 0) {
          return { ...d, closed: false, intervals: [defaultInterval()] };
        }
        return { ...d, closed };
      }),
    );
  }, []);

  const addInterval = useCallback((day: number) => {
    setDays((prev) =>
      prev.map((d) =>
        d.day === day && d.intervals.length < MAX_INTERVALS_PER_DAY
          ? { ...d, intervals: [...d.intervals, defaultInterval()] }
          : d,
      ),
    );
  }, []);

  const updateInterval = useCallback(
    (day: number, key: string, patch: Partial<Pick<IntervalDraft, "open" | "close">>) => {
      setDays((prev) =>
        prev.map((d) =>
          d.day === day
            ? { ...d, intervals: d.intervals.map((iv) => (iv.key === key ? { ...iv, ...patch } : iv)) }
            : d,
        ),
      );
    },
    [],
  );

  const removeInterval = useCallback((day: number, key: string) => {
    setDays((prev) =>
      prev.map((d) => {
        if (d.day !== day) return d;
        const next = d.intervals.filter((iv) => iv.key !== key);
        // Removing the last interval closes the day (an open day needs at least one).
        return next.length === 0 ? { ...d, closed: true, intervals: [] } : { ...d, intervals: next };
      }),
    );
  }, []);

  /** Ergonomics: copy Monday's hours to Tue–Fri (the common "same weekday hours" case). */
  const copyMondayToWeekdays = useCallback(() => {
    setDays((prev) => {
      const monday = prev.find((d) => d.day === 0);
      if (!monday) return prev;
      return prev.map((d) =>
        d.day >= 1 && d.day <= 4
          ? {
              day: d.day,
              closed: monday.closed,
              intervals: monday.intervals.map((iv) => ({ ...iv, key: crypto.randomUUID() })),
            }
          : d,
      );
    });
  }, []);

  /** Ergonomics: copy the previous day's hours into this one. */
  const copyFromPrevious = useCallback((day: number) => {
    if (day === 0) return;
    setDays((prev) => {
      const source = prev.find((d) => d.day === day - 1);
      if (!source) return prev;
      return prev.map((d) =>
        d.day === day
          ? {
              day,
              closed: source.closed,
              intervals: source.intervals.map((iv) => ({ ...iv, key: crypto.randomUUID() })),
            }
          : d,
      );
    });
  }, []);

  const anyInvalid = useMemo(
    () => days.some((d) => !d.closed && d.intervals.some((iv) => intervalIssue(iv) !== null)),
    [days],
  );
  const canSave = !busy && !anyInvalid;

  const reset = useCallback(() => {
    setDays(periodsToDrafts(initialPeriods));
    setError(null);
    setSavedTick(false);
  }, [initialPeriods]);

  /** Clear all hours (back to no structured hours — opening_times null). */
  const clearAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSavedTick(false);
    try {
      const updateVenueHours = trpc.venues.updateVenueHours as unknown as UpdateVenueHoursMutation;
      const res = await updateVenueHours.mutate({ venueId, periods: null, timezone: DEFAULT_TIMEZONE });
      if (!res.ok) {
        setError("Couldn't clear your hours. Please try again.");
        return;
      }
      setSavedTick(true);
      await onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't clear your hours.");
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, onSaved]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSavedTick(false);
    try {
      // Build the periods array the server expects: every day, closed days carry no
      // intervals. The server re-validates + derives; this is the friendly mirror.
      const periods: PeriodInput[] = days.map((d) => ({
        day: d.day,
        closed: d.closed,
        intervals: d.closed
          ? []
          : d.intervals
              .filter((iv) => iv.open && iv.close)
              .map((iv) => ({ open: iv.open, close: iv.close })),
      }));

      const updateVenueHours = trpc.venues.updateVenueHours as unknown as UpdateVenueHoursMutation;
      const res = await updateVenueHours.mutate({ venueId, periods, timezone: DEFAULT_TIMEZONE });
      if (!res.ok) {
        setError("Couldn't save your hours. Please try again.");
        return;
      }
      setSavedTick(true);
      await onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't save your hours.");
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, days, onSaved]);

  const timeInputStyle: React.CSSProperties = {
    padding: "var(--space-2) var(--space-3)",
    border: "1px solid var(--line-2)",
    borderRadius: 10,
    background: "#fff",
    color: "var(--ink)",
    font: "inherit",
    boxSizing: "border-box",
  };

  return (
    <div>
      <div style={{ marginBottom: "var(--space-4)" }}>
        <Button variant="neutral" size="sm" disabled={busy} onClick={copyMondayToWeekdays}>
          Copy Monday to Tue–Fri
        </Button>
      </div>

      <div style={{ display: "grid", gap: "var(--space-4)" }}>
        {days.map((d) => (
          <div key={d.day} style={{ display: "grid", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
              <strong style={{ minWidth: 96, color: "var(--ink)" }}>{DAY_NAMES[d.day]}</strong>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}>
                <input
                  type="checkbox"
                  checked={d.closed}
                  onChange={(e) => toggleClosed(d.day, e.target.checked)}
                  disabled={busy}
                />
                Closed
              </label>
              {d.day > 0 && !d.closed ? (
                <Button variant="neutral" size="sm" disabled={busy} onClick={() => copyFromPrevious(d.day)}>
                  Same as {DAY_NAMES[d.day - 1]}
                </Button>
              ) : null}
            </div>

            {!d.closed ? (
              <div style={{ display: "grid", gap: 6, paddingLeft: 4 }}>
                {d.intervals.map((iv) => {
                  const issue = intervalIssue(iv);
                  return (
                    <div key={iv.key} style={{ display: "grid", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                        <input
                          type="time"
                          value={iv.open}
                          onChange={(e) => updateInterval(d.day, iv.key, { open: e.target.value })}
                          style={timeInputStyle}
                          disabled={busy}
                          aria-label={`${DAY_NAMES[d.day]} opening time`}
                        />
                        <span style={{ color: "var(--muted)" }}>to</span>
                        <input
                          type="time"
                          value={iv.close}
                          onChange={(e) => updateInterval(d.day, iv.key, { close: e.target.value })}
                          style={timeInputStyle}
                          disabled={busy}
                          aria-label={`${DAY_NAMES[d.day]} closing time`}
                        />
                        <Button
                          variant="neutral"
                          size="sm"
                          disabled={busy}
                          onClick={() => removeInterval(d.day, iv.key)}
                        >
                          Remove
                        </Button>
                      </div>
                      {issue ? (
                        <div style={{ fontSize: 12, color: "var(--crimson-700)" }}>{issue}</div>
                      ) : isOvernight(iv) ? (
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>Closes after midnight (next day).</div>
                      ) : null}
                    </div>
                  );
                })}
                {d.intervals.length < MAX_INTERVALS_PER_DAY ? (
                  <div>
                    <Button variant="neutral" size="sm" disabled={busy} onClick={() => addInterval(d.day)}>
                      + Add a break
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {error ? (
        <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-4)" }} role="alert">
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginTop: "var(--space-5)" }}>
        <Button variant="pri" disabled={!canSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save hours"}
        </Button>
        <Button variant="neutral" size="sm" disabled={busy} onClick={reset}>
          Reset
        </Button>
        <Button variant="neutral" size="sm" disabled={busy} onClick={() => void clearAll()}>
          Clear all
        </Button>
        {savedTick && !busy ? <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Saved.</span> : null}
      </div>
    </div>
  );
}
