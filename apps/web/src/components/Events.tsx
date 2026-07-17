/**
 * Events — the "what's on" board (/events), scoped to the place you're browsing (PlaceSwitcher,
 * shared with Explore/Town Hall). Lists UPCOMING community events soonest-first, with a category
 * filter, an inline composer (auth prompted just-in-time), and a per-card "interested" toggle.
 *
 * PUBLIC to read (browse any town signed-out, the browse-freely contract); posting or marking
 * interest needs an account. This one URL shows different towns by state so it's noindex — the
 * indexable surface is each event's own /events/{id} page (and, in PR 3, the town hubs).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { AuthorLink } from "./AuthorLink";
import { eventPath } from "../lib/routes";
import { EVENT_CATEGORIES, eventCategoryKey, formatEventWhen, eventDateBadge } from "../lib/events";

interface EventListItem {
  id: string;
  localityLabel: string;
  title: string;
  description: string | null;
  category: string | null;
  startsAt: string;
  endsAt: string | null;
  venueId: string | null;
  locationName: string | null;
  url: string | null;
  interestedCount: number;
  status: string;
  author: { id: string | null; handle: string | null; displayName: string | null; avatarUrl: string | null };
  venue: { id: string; name: string | null; slug: string | null } | null;
  viewerInterested: boolean;
}

const inputStyle: React.CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line-2)",
  fontFamily: "var(--ui)",
  fontSize: 14,
  marginBottom: "var(--space-3)",
  background: "#fff",
  color: "var(--ink)",
};

export function Events() {
  const t = useTranslations("events");
  const trpc = useTrpc();
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();

  const [events, setEvents] = useState<EventListItem[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [venuePrefill, setVenuePrefill] = useState<{ id: string; name: string } | null>(null);

  // Deep-links: /events?new=1 opens the composer; &venue=<id>&venueName=<name> pre-attaches a venue
  // (the "post an event here" affordance on a venue page).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("new") === "1") setComposing(true);
    const vid = p.get("venue");
    if (vid) {
      setVenuePrefill({ id: vid, name: p.get("venueName") ?? "" });
      setComposing(true);
    }
  }, []);

  const load = useCallback(async () => {
    setEvents(undefined);
    setError(null);
    const list = trpc.events.listByLocality as unknown as {
      query: (i: { localityName: string; category?: string }) => Promise<{ events: EventListItem[] }>;
    };
    try {
      const res = await list.query({ localityName: place.name, ...(category ? { category } : {}) });
      setEvents(res.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
    }
  }, [trpc, place.name, category, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPosted = useCallback(() => {
    setComposing(false);
    void load();
  }, [load]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          {t("kicker")}
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>
          {t("title", { place: place.name })}
        </h1>
        <p style={{ margin: "var(--space-2) 0 var(--space-4)", color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.5 }}>
          {t("subtitle", { place: place.name })}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}>
          <PlaceSwitcher value={place} onChange={setPlace} />
          {!composing ? (
            <Button variant="pri" onClick={() => setComposing(true)}>＋ {t("post")}</Button>
          ) : null}
        </div>
      </header>

      {/* Category filter */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "var(--space-4)" }}>
        <FilterChip on={category === null} onClick={() => setCategory(null)}>{t("all")}</FilterChip>
        {EVENT_CATEGORIES.map((c) => (
          <FilterChip key={c.id} on={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
            {t(`categories.${c.labelKey}`)}
          </FilterChip>
        ))}
      </div>

      {composing ? (
        session?.user ? (
          <EventComposer
            localityName={place.name}
            lat={place.lat}
            lng={place.lng}
            {...(venuePrefill ? { venueId: venuePrefill.id, initialLocation: venuePrefill.name } : {})}
            onPosted={onPosted}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <AuthPanel
              intro={t("signInToPost", { place: place.name })}
              emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
              onAuthed={() => {
                /* session change re-renders; the composer shows next */
              }}
            />
          </Card>
        )
      ) : null}

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center", color: "var(--ink-2)" }}>{error}</Card>
      ) : events === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {[0, 1, 2].map((i) => (
            <Card key={i} style={{ padding: "var(--space-4)", opacity: 0.5 }}>
              <div style={{ height: 16, width: "60%", background: "var(--paper-2)", borderRadius: 6, marginBottom: 8 }} />
              <div style={{ height: 12, width: "40%", background: "var(--paper-2)", borderRadius: 6 }} />
            </Card>
          ))}
        </div>
      ) : events.length === 0 ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            {t("empty.title", { place: place.name })}
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>{t("empty.body")}</p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </div>
      )}
    </main>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "6px 13px", borderRadius: 999,
        fontFamily: "var(--ui)", fontSize: 12.5, fontWeight: 600,
        border: `1px solid ${on ? "var(--crimson-tint-2)" : "var(--line-2)"}`,
        background: on ? "var(--crimson-tint)" : "#fff",
        color: on ? "var(--crimson-700)" : "var(--ink-2)",
      }}
    >
      {children}
    </button>
  );
}

function EventRow({ event }: { event: EventListItem }) {
  const t = useTranslations("events");
  const trpc = useTrpc();
  const session = useSession();
  const [interested, setInterested] = useState(event.viewerInterested);
  const [count, setCount] = useState(event.interestedCount);
  const [busy, setBusy] = useState(false);

  const badge = eventDateBadge(event.startsAt);
  const catKey = eventCategoryKey(event.category);
  const where = event.venue?.name || event.locationName || event.localityLabel;

  const toggle = useCallback(async () => {
    if (!session?.user || busy) return;
    setBusy(true);
    const m = trpc.events.toggleInterest as unknown as {
      mutate: (i: { eventId: string }) => Promise<{ interested: boolean; interestedCount: number }>;
    };
    try {
      const res = await m.mutate({ eventId: event.id });
      setInterested(res.interested);
      setCount(res.interestedCount);
    } catch {
      /* leave state unchanged on failure */
    } finally {
      setBusy(false);
    }
  }, [trpc, session, busy, event.id]);

  return (
    <Card style={{ padding: "var(--space-4)", display: "flex", gap: "var(--space-3)", opacity: event.status === "cancelled" ? 0.65 : 1 }}>
      {/* Date badge */}
      <div aria-hidden style={{ flexShrink: 0, width: 52, textAlign: "center", borderRadius: 10, border: "1px solid var(--line)", padding: "6px 4px", background: "var(--paper-2)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", color: "var(--crimson-700)", fontWeight: 700 }}>{badge.month}</div>
        <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 20, lineHeight: 1 }}>{badge.day}</div>
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <Link href={eventPath(event.id)} style={{ textDecoration: "none", color: "inherit" }}>
          <h3 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, lineHeight: 1.3, margin: 0 }}>
            {event.status === "cancelled" ? <span style={{ color: "var(--crimson-700)" }}>{t("cancelledPrefix")} </span> : null}
            {event.title}
          </h3>
        </Link>
        <div style={{ marginTop: 3, fontSize: 13, color: "var(--ink-2)" }}>{formatEventWhen(event.startsAt, event.endsAt)}</div>
        <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {event.venue?.slug || event.venue?.id ? (
            <Link href={`/venue/${event.venue.slug ?? event.venue.id}`} style={{ color: "var(--muted)", textDecoration: "none" }}>{where}</Link>
          ) : (
            <span>{where}</span>
          )}
          {catKey ? (<><span aria-hidden>·</span><span>{t(`categories.${catKey}`)}</span></>) : null}
        </div>

        <div style={{ marginTop: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <button
            type="button"
            onClick={toggle}
            aria-pressed={interested}
            disabled={busy || !session?.user}
            title={!session?.user ? t("signInToInterest") : undefined}
            style={{
              all: "unset", boxSizing: "border-box", cursor: session?.user ? "pointer" : "not-allowed",
              display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 13px", borderRadius: 999,
              fontFamily: "var(--ui)", fontSize: 12.5, fontWeight: 600,
              border: `1px solid ${interested ? "var(--crimson-tint-2)" : "var(--line-2)"}`,
              background: interested ? "var(--crimson-tint)" : "#fff",
              color: interested ? "var(--crimson-700)" : "var(--ink-2)",
              opacity: session?.user ? 1 : 0.6,
            }}
          >
            <Icon name="heart" size={14} />
            {interested ? t("interested") : t("interest")}
            {count > 0 ? <span style={{ color: "var(--muted)", fontWeight: 500 }}>· {count}</span> : null}
          </button>
          {event.author.id ? (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {t("by")} <AuthorLink author={event.author} style={{ color: "var(--ink-2)" }} />
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/* ── Composer ────────────────────────────────────────────────────────────────────────────── */

function EventComposer({
  localityName,
  lat,
  lng,
  venueId,
  initialLocation,
  onPosted,
  onCancel,
}: {
  localityName: string;
  lat: number;
  lng: number;
  venueId?: string;
  initialLocation?: string;
  onPosted: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("events");
  const trpc = useTrpc();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [locationName, setLocationName] = useState(initialLocation ?? "");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    // datetime-local is local wall-clock; toISOString() normalises to UTC for the API.
    const startIso = startsAt ? new Date(startsAt).toISOString() : "";
    const endIso = endsAt ? new Date(endsAt).toISOString() : "";
    const create = trpc.events.create as unknown as {
      mutate: (i: {
        localityName: string; title: string; description?: string; category?: string;
        startsAt: string; endsAt?: string; venueId?: string; locationName?: string; lat?: number; lng?: number; url?: string;
      }) => Promise<{ id: string }>;
    };
    try {
      await create.mutate({
        localityName,
        title: title.trim(),
        startsAt: startIso,
        lat,
        lng,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(category ? { category } : {}),
        ...(endIso ? { endsAt: endIso } : {}),
        ...(venueId ? { venueId } : {}),
        ...(locationName.trim() ? { locationName: locationName.trim() } : {}),
        ...(/^https?:\/\//i.test(url.trim()) ? { url: url.trim() } : {}),
      });
      onPosted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("postFailed"));
      setBusy(false);
    }
  }, [trpc, localityName, lat, lng, venueId, title, description, category, startsAt, endsAt, locationName, url, onPosted, t]);

  const canPost = title.trim().length > 0 && startsAt.length > 0 && locationName.trim().length > 0 && !busy;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
        {t("composer.title", { place: localityName })}
      </div>

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("composer.titlePlaceholder")} aria-label={t("composer.titleAria")} maxLength={140} style={inputStyle} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("composer.descPlaceholder")} aria-label={t("composer.descAria")} rows={3} style={{ ...inputStyle, resize: "vertical", minHeight: 80 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)" }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>
          {t("composer.starts")}
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-label={t("composer.starts")} style={{ ...inputStyle, marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>
          {t("composer.ends")}
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-label={t("composer.ends")} style={{ ...inputStyle, marginTop: 4 }} />
        </label>
      </div>

      <input value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder={t("composer.placePlaceholder")} aria-label={t("composer.placeAria")} maxLength={200} style={inputStyle} />

      {/* Category picker — optional, single-select. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "var(--space-3)" }}>
        {EVENT_CATEGORIES.map((c) => (
          <FilterChip key={c.id} on={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
            {t(`categories.${c.labelKey}`)}
          </FilterChip>
        ))}
      </div>

      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("composer.urlPlaceholder")} aria-label={t("composer.urlAria")} inputMode="url" style={inputStyle} />

      {err ? <div style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}

      <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>{t("composer.cancel")}</Button>
        <Button variant="pri" onClick={submit} disabled={!canPost}>{busy ? t("composer.posting") : t("composer.post")}</Button>
      </div>
    </Card>
  );
}
