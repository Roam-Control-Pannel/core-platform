/**
 * EventScreen — the public event detail at /events/{id}. Server-rendered from the SSR-fetched
 * `initial` event (so crawlers and first paint get the full content + JSON-LD from the page), then
 * hydrated client-side: on mount it re-fetches byId with the session so the "interested" state and
 * live count are the viewer's own. Interest/report need an account, prompted just-in-time.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthorLink } from "./AuthorLink";
import { CopyLinkButton } from "./CopyLinkButton";
import { eventCategoryKey, formatEventWhen } from "../lib/events";
import type { EventSeo } from "../lib/serverApi";

interface EventFull extends EventSeo {
  viewerInterested: boolean;
}

export function EventScreen({ initial }: { initial: EventSeo }) {
  const t = useTranslations("events");
  const trpc = useTrpc();
  const session = useSession();
  const [ev, setEv] = useState<EventFull>({ ...initial, viewerInterested: false });
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);

  // Hydrate the viewer's own interested state + latest count once mounted (SSR read is anonymous).
  useEffect(() => {
    const q = trpc.events.byId as unknown as { query: (i: { eventId: string }) => Promise<EventFull | null> };
    q.query({ eventId: initial.id }).then((full) => { if (full) setEv(full); }).catch(() => {});
  }, [trpc, initial.id]);

  const toggle = useCallback(async () => {
    if (!session?.user || busy) return;
    setBusy(true);
    const m = trpc.events.toggleInterest as unknown as {
      mutate: (i: { eventId: string }) => Promise<{ interested: boolean; interestedCount: number }>;
    };
    try {
      const res = await m.mutate({ eventId: ev.id });
      setEv((p) => ({ ...p, viewerInterested: res.interested, interestedCount: res.interestedCount }));
    } catch {
      /* leave unchanged */
    } finally {
      setBusy(false);
    }
  }, [trpc, session, busy, ev.id]);

  const report = useCallback(async () => {
    if (!session?.user || reported) return;
    const m = trpc.events.reportEvent as unknown as { mutate: (i: { eventId: string }) => Promise<{ ok: boolean }> };
    try {
      await m.mutate({ eventId: ev.id });
      setReported(true);
    } catch {
      /* no-op */
    }
  }, [trpc, session, reported, ev.id]);

  const catKey = eventCategoryKey(ev.category);
  const where = ev.venue?.name || ev.locationName || ev.localityLabel;
  const cancelled = ev.status === "cancelled";

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link href="/events" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}>
        <span aria-hidden>←</span> {t("kicker")}
      </Link>

      <header style={{ marginBottom: "var(--space-4)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          {ev.localityLabel}{catKey ? ` · ${t(`categories.${catKey}`)}` : ""}
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>
          {cancelled ? <span style={{ color: "var(--crimson-700)" }}>{t("cancelledPrefix")} </span> : null}
          {ev.title}
        </h1>
      </header>

      <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
        <DetailRow icon="clock" label={t("detail.when")} value={formatEventWhen(ev.startsAt, ev.endsAt)} />
        <DetailRow
          icon="place"
          label={t("detail.where")}
          value={
            ev.venue?.slug || ev.venue?.id ? (
              <Link href={`/venue/${ev.venue.slug ?? ev.venue.id}`} style={{ color: "var(--crimson-700)", textDecoration: "none" }}>{where}</Link>
            ) : (
              where
            )
          }
        />
        {ev.url ? (
          <DetailRow
            icon="link"
            label={t("detail.link")}
            value={<a href={ev.url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--crimson-700)" }}>{t("detail.moreInfo")}</a>}
          />
        ) : null}
      </Card>

      {ev.description ? (
        <p style={{ whiteSpace: "pre-wrap", color: "var(--ink)", fontSize: 15, lineHeight: 1.6, margin: "0 0 var(--space-5)" }}>{ev.description}</p>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-5)" }}>
        <Button variant={ev.viewerInterested ? "neutral" : "pri"} onClick={toggle} disabled={busy || !session?.user || cancelled}>
          <Icon name="heart" size={15} />{" "}
          {ev.viewerInterested ? t("interested") : t("interest")}
          {ev.interestedCount > 0 ? ` · ${ev.interestedCount}` : ""}
        </Button>
        <CopyLinkButton path={`/events/${ev.id}`} label={t("detail.share")} />
      </div>

      <footer style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--space-4)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", fontSize: 13, color: "var(--muted)" }}>
        <span>
          {ev.author.id ? (<>{t("by")} <AuthorLink author={ev.author} style={{ color: "var(--ink-2)" }} /></>) : t("bySomeone")}
        </span>
        {session?.user ? (
          <button type="button" onClick={report} disabled={reported} style={{ all: "unset", cursor: reported ? "default" : "pointer", fontSize: 12.5, color: "var(--muted)" }}>
            {reported ? t("reported") : t("report")}
          </button>
        ) : null}
      </footer>
    </main>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}>
        <Icon name={icon as never} size={15} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>{label}</div>
        <div style={{ fontSize: 14.5, color: "var(--ink)", marginTop: 1 }}>{value}</div>
      </div>
    </div>
  );
}
