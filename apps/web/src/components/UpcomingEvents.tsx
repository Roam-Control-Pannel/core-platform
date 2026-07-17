/**
 * UpcomingEvents — a compact, server-rendered list of events for the town hub ("What's on in
 * {town}") and the venue page ("What's on here"). Text-forward with a date badge, each row an
 * internal link to /events/{id}; server component (no "use client") so it ships in the initial
 * HTML and feeds the indexable discovery surfaces. Optional "post an event" affordance.
 */
import Link from "next/link";
import { Card, Icon, type IconName } from "@roam/design";
import { eventDateBadge, formatEventWhen, eventCategoryLabelEn } from "../lib/events";
import type { HubEvent } from "../lib/serverApi";

export function UpcomingEvents({
  title,
  events,
  postHref,
  postLabel,
  emptyIcon = "event",
  emptyBody,
}: {
  title: string;
  events: HubEvent[];
  postHref?: string;
  postLabel?: string;
  emptyIcon?: IconName;
  emptyBody?: string;
}) {
  return (
    <section style={{ marginBottom: "var(--space-6)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: 0 }}>
          {title}
          {events.length > 0 ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {events.length}</span> : null}
        </h2>
        {postHref ? (
          <Link href={postHref} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none", whiteSpace: "nowrap" }}>
            ＋ {postLabel}
          </Link>
        ) : null}
      </div>

      {events.length === 0 ? (
        <Card flat style={{ padding: "var(--space-5)", borderStyle: "dashed", borderColor: "var(--line)", background: "var(--paper-2)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <span aria-hidden style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}>
              <Icon name={emptyIcon} size={18} />
            </span>
            <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5 }}>{emptyBody}</p>
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {events.map((e) => {
            const badge = eventDateBadge(e.startsAt);
            const cat = eventCategoryLabelEn(e.category);
            const where = e.venue?.name || e.locationName;
            return (
              <Link key={e.id} href={`/events/${e.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <Card style={{ padding: "var(--space-3) var(--space-4)", display: "flex", gap: "var(--space-3)", alignItems: "center", opacity: e.status === "cancelled" ? 0.65 : 1 }}>
                  <div aria-hidden style={{ flexShrink: 0, width: 46, textAlign: "center", borderRadius: 9, border: "1px solid var(--line)", padding: "5px 4px", background: "var(--paper-2)" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".05em", color: "var(--crimson-700)", fontWeight: 700 }}>{badge.month}</div>
                    <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 18, lineHeight: 1 }}>{badge.day}</div>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15.5, lineHeight: 1.3 }}>
                      {e.status === "cancelled" ? <span style={{ color: "var(--crimson-700)" }}>Cancelled: </span> : null}
                      {e.title}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span>{formatEventWhen(e.startsAt, e.endsAt)}</span>
                      {where ? (<><span aria-hidden>·</span><span>{where}</span></>) : null}
                      {cat ? (<><span aria-hidden>·</span><span>{cat}</span></>) : null}
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
