/**
 * MeetupPanel — Stage 2c-ii. The crown-jewel meet-up poll, surfaced inline on a
 * group ThreadDetail (/threads/[id]). Frontend over the proven Stage 2a meetup
 * router; the only new backend is the read-only meetup.forThread discovery query
 * (the router had no thread->meetup read — createMeetup's CONFLICT guard is a
 * write-guard, not a lookup).
 *
 * Lifecycle surfaced (mirrors @roam/core/meetup canTransition): no live meet-up ->
 * "Start a meet-up"; voting (add venues, vote/switch, try to resolve, end);
 * resolved (winner fixed, end); ended (read-only). Within voting the poll reads
 * no-votes / tie / clear-winner straight off core's Resolution.reason.
 *
 * Venue options: a real near->far picker via venues.near, rooted on the same
 * PlaceSwitcher PLACES/DEFAULT_PLACE constants Explore uses (no shared place context
 * exists yet — when one lands, swap the source, keep the contract). venues.near
 * returns `name`, so the optionId->venue-name map for PollCard is built from picker
 * results directly; venues.byId is the fallback for an option another participant
 * added that isn't in the local map.
 *
 * State ladder per the codebase idiom: error -> undefined(skeleton) -> null/empty ->
 * content. Dates are ISO strings. Gates on useSession() (private surface). Group-only
 * is enforced by the caller (ThreadDetail renders this only when thread.isGroup).
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, Pill, PollCard } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PLACES, DEFAULT_PLACE, type Place } from "./PlaceSwitcher";

interface LiveMeetup {
  id: string;
  state: "voting" | "resolved" | "ended";
}

interface OptionTally {
  optionId: string;
  venueId: string;
  count: number;
}

interface Resolution {
  resolved: boolean;
  winner?: OptionTally;
  tally: OptionTally[];
  reason?: "no_votes" | "tie";
}

interface VenueRow {
  id: string;
  name: string;
  distanceM?: number;
}

export function MeetupPanel({ threadId }: { threadId: string }) {
  const t = useTranslations("meetupPanel");
  const trpc = useTrpc();
  const session = useSession();

  const [meetup, setMeetup] = useState<LiveMeetup | null | undefined>(undefined);
  const [meetupError, setMeetupError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution | null | undefined>(undefined);
  const [venueNames, setVenueNames] = useState<Record<string, string>>({});
  // Live mirror of venueNames for loadResolution's "which ids are still unknown?" check.
  // Reading the map through a ref (instead of closing over the state) keeps loadResolution's
  // identity stable across name fills — without it, setVenueNames → new loadResolution →
  // the resolution effect re-fires the query (with a setResolution(undefined) flash) every
  // time a name resolves. The ref breaks that loop while still seeing the latest names.
  const venueNamesRef = useRef(venueNames);
  useEffect(() => {
    venueNamesRef.current = venueNames;
  }, [venueNames]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadMeetup = useCallback(() => {
    let cancelled = false;
    setMeetup(undefined);
    setMeetupError(null);
    trpc.meetup.forThread
      .query({ threadId })
      .then((m) => {
        if (!cancelled) setMeetup((m as LiveMeetup | null) ?? null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMeetupError(e instanceof Error ? e.message : t("errors.load"));
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, threadId]);

  useEffect(() => {
    if (!session) {
      setMeetup(undefined);
      return;
    }
    return loadMeetup();
  }, [session, loadMeetup]);

  const loadResolution = useCallback(
    (meetupId: string) => {
      let cancelled = false;
      setResolution(undefined);
      trpc.meetup.resolution
        .query({ meetupId })
        .then(async (r) => {
          if (cancelled) return;
          const res = r as Resolution;
          setResolution(res);
          const unknown = res.tally
            .map((t) => t.venueId)
            .filter((vid) => !(vid in venueNamesRef.current));
          if (unknown.length > 0) {
            const pairs = await Promise.all(
              unknown.map(async (vid) => {
                try {
                  const v = (await trpc.venues.byId.query({ venueId: vid })) as VenueRow | null;
                  return [vid, v?.name ?? t("unknownVenue")] as const;
                } catch {
                  return [vid, t("unknownVenue")] as const;
                }
              }),
            );
            if (!cancelled) {
              setVenueNames((prev) => {
                const next = { ...prev };
                for (const [vid, name] of pairs) next[vid] = name;
                return next;
              });
            }
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setResolution(null);
          setActionError(e instanceof Error ? e.message : t("errors.poll"));
        });
      return () => {
        cancelled = true;
      };
    },
    [trpc],
  );

  useEffect(() => {
    if (!meetup) {
      setResolution(undefined);
      return;
    }
    return loadResolution(meetup.id);
  }, [meetup, loadResolution]);

  const refresh = useCallback(() => {
    if (meetup) loadResolution(meetup.id);
  }, [meetup, loadResolution]);

  const startMeetup = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const m = (await trpc.meetup.createMeetup.mutate({ threadId })) as { id: string; state: string };
      setMeetup({ id: m.id, state: "voting" });
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : t("errors.start"));
    } finally {
      setBusy(false);
    }
  }, [trpc, threadId]);

  const addOption = useCallback(
    async (venue: VenueRow) => {
      if (!meetup) return;
      setBusy(true);
      setActionError(null);
      try {
        await trpc.meetup.addOption.mutate({ meetupId: meetup.id, venueId: venue.id });
        setVenueNames((prev) => ({ ...prev, [venue.id]: venue.name }));
        refresh();
      } catch (e: unknown) {
        setActionError(e instanceof Error ? e.message : t("errors.addVenue"));
      } finally {
        setBusy(false);
      }
    },
    [trpc, meetup, refresh],
  );

  const castVote = useCallback(
    async (optionId: string) => {
      if (!meetup) return;
      setBusy(true);
      setActionError(null);
      try {
        await trpc.meetup.castVote.mutate({ meetupId: meetup.id, optionId });
        refresh();
      } catch (e: unknown) {
        setActionError(e instanceof Error ? e.message : t("errors.vote"));
      } finally {
        setBusy(false);
      }
    },
    [trpc, meetup, refresh],
  );

  const tryResolve = useCallback(async () => {
    if (!meetup) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = (await trpc.meetup.tryResolve.mutate({ meetupId: meetup.id })) as Resolution;
      setResolution(r);
      if (r.resolved) setMeetup({ id: meetup.id, state: "resolved" });
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : t("errors.resolve"));
    } finally {
      setBusy(false);
    }
  }, [trpc, meetup]);

  const endMeetup = useCallback(async () => {
    if (!meetup) return;
    setBusy(true);
    setActionError(null);
    try {
      await trpc.meetup.end.mutate({ meetupId: meetup.id });
      setMeetup({ id: meetup.id, state: "ended" });
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : t("errors.end"));
    } finally {
      setBusy(false);
    }
  }, [trpc, meetup]);

  const pollOptions = useMemo(
    () =>
      (resolution?.tally ?? []).map((tally) => ({
        optionId: tally.optionId,
        label: venueNames[tally.venueId] ?? t("loading"),
        count: tally.count,
      })),
    // t IS a dep here (unlike the fetch-effect baseline): the memo bakes a visible label
    // fallback into render output, which must recompute when the language changes.
    [resolution, venueNames, t],
  );

  if (!session) return null;

  return (
    <section style={{ marginTop: "var(--space-8)" }}>
      <SectionLabel>{t("title")}</SectionLabel>

      {meetupError ? (
        <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-2)" }}>
          <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>{meetupError}</p>
        </Card>
      ) : meetup === undefined ? (
        <PanelSkeleton />
      ) : meetup === null ? (
        <StartCard onStart={startMeetup} busy={busy} error={actionError} />
      ) : (
        <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <Pill variant={meetup.state === "ended" ? "neutral" : "ghost-crim"} size="sm">
              {meetup.state === "voting" ? t("stateVoting") : meetup.state === "resolved" ? t("stateResolved") : t("stateEnded")}
            </Pill>
            {resolution?.reason === "tie" && meetup.state === "voting" ? (
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{t("tie")}</span>
            ) : null}
          </div>

          {resolution === undefined ? (
            <PollSkeleton />
          ) : resolution === null ? (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>{t("errors.poll")}</p>
          ) : resolution.tally.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
              {meetup.state === "voting" ? t("noVenuesVoting") : t("noVenues")}
            </p>
          ) : (
            <>
              <PollCard options={pollOptions} winnerOptionId={resolution.winner?.optionId} />
              {meetup.state === "voting" ? (
                <div style={{ display: "grid", gap: 6, marginTop: "var(--space-3)" }}>
                  {pollOptions.map((o) => (
                    <Button key={o.optionId} variant="neutral" onClick={() => castVote(o.optionId)} disabled={busy}>
                      {t("voteFor", { venue: o.label })}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          )}

          {meetup.state === "voting" ? <VenuePicker onPick={addOption} busy={busy} /> : null}

          {resolution?.resolved && meetup.state !== "ended" ? (
            <div style={{ marginTop: "var(--space-3)", fontSize: 13 }}>
              {t.rich("meetingAt", {
                venueName: venueNames[resolution.winner?.venueId ?? ""] ?? t("winningVenue"),
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </div>
          ) : null}

          {actionError ? (
            <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }} role="alert">
              {actionError}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)", flexWrap: "wrap" }}>
            {meetup.state === "voting" ? (
              <Button variant="pri" onClick={tryResolve} disabled={busy}>
                {busy ? t("working") : t("resolve")}
              </Button>
            ) : null}
            {meetup.state !== "ended" ? (
              <Button variant="neutral" onClick={endMeetup} disabled={busy}>
                {t("endMeetup")}
              </Button>
            ) : (
              <span style={{ fontSize: 13, color: "var(--muted)" }}>{t("ended")}</span>
            )}
          </div>
        </Card>
      )}
    </section>
  );
}

function VenuePicker({ onPick, busy }: { onPick: (v: VenueRow) => void; busy: boolean }) {
  const t = useTranslations("meetupPanel");
  const trpc = useTrpc();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place>(DEFAULT_PLACE);
  const [venues, setVenues] = useState<VenueRow[] | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVenues(undefined);
    trpc.venues.near
      .query({ lat: place.lat, lng: place.lng, limit: 50 })
      .then((rows) => {
        if (!cancelled) setVenues(rows as VenueRow[]);
      })
      .catch(() => {
        if (!cancelled) setVenues(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, place, trpc]);

  if (!open) {
    return (
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button variant="neutral" onClick={() => setOpen(true)} disabled={busy}>
          {t("addVenue")}
        </Button>
      </div>
    );
  }

  return (
    <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-3)" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
        {PLACES.map((p) => (
          <Button key={p.id} variant={p.id === place.id ? "pri" : "neutral"} size="sm" onClick={() => setPlace(p)}>
            {p.name}
          </Button>
        ))}
      </div>
      {venues === undefined ? (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("venuesLoading", { place: place.name })}</p>
      ) : venues === null ? (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("venuesLoadFailed")}</p>
      ) : venues.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{t("venuesEmpty", { place: place.name })}</p>
      ) : (
        <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
          {venues.map((v) => (
            <Button key={v.id} variant="neutral" onClick={() => onPick(v)} disabled={busy} style={{ justifyContent: "flex-start" }}>
              {v.name}
            </Button>
          ))}
        </div>
      )}
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button variant="neutral" onClick={() => setOpen(false)}>
          {t("done")}
        </Button>
      </div>
    </Card>
  );
}

function StartCard({ onStart, busy, error }: { onStart: () => void; busy: boolean; error: string | null }) {
  const t = useTranslations("meetupPanel");
  return (
    <Card flat style={{ padding: "var(--space-5)", marginTop: "var(--space-2)" }}>
      <p style={{ margin: 0, marginBottom: "var(--space-3)", color: "var(--muted)", fontSize: 13.5 }}>
        {t("startBody")}
      </p>
      {error ? (
        <div style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }} role="alert">
          {error}
        </div>
      ) : null}
      <Button variant="pri" onClick={onStart} disabled={busy}>
        {busy ? t("starting") : t("start")}
      </Button>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

function PanelSkeleton() {
  return <div style={{ height: 96, background: "var(--paper-2)", borderRadius: 12, marginTop: "var(--space-2)" }} />;
}

function PollSkeleton() {
  return <div style={{ height: 120, background: "var(--paper-2)", borderRadius: 12 }} />;
}
