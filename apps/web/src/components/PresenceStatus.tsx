/**
 * PresenceStatus — the signed-in user's own availability control (PR 1 of "share with friends").
 *
 * Lets you broadcast a lightweight, self-expiring status ("Free for a coffee") that ONLY your
 * accepted friends can see (the friend-only boundary is enforced in the DB — migration 0092). Pick
 * one of three states, optionally add a note, Share; or Clear to stop sharing. The status expires
 * on its own server-side, so this is deliberately low-commitment.
 *
 * Self-contained: loads presence.myAvailability on mount, writes via presence.setAvailability.
 * Renders nothing until we know whether you're signed in (it lives on a protected surface).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

type Availability = "free_to_meet" | "out_and_about" | "heads_down";
const OPTIONS: readonly Availability[] = ["free_to_meet", "out_and_about", "heads_down"];

/** The dot colour per state — a calm cue, not a full traffic-light. */
const DOT: Record<Availability, string> = {
  free_to_meet: "var(--positive, #1f9d55)",
  out_and_about: "var(--crimson-600, #d1466b)",
  heads_down: "var(--muted)",
};

interface PresenceRow {
  availability: Availability | null;
  note: string | null;
  expires_at: string | null;
}

const NOTE_MAX = 80;

export function PresenceStatus() {
  const t = useTranslations("presence");
  const trpc = useTrpc();
  const session = useSession();
  const hasSession = !!session;

  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<PresenceRow | null>(null);
  const [selected, setSelected] = useState<Availability | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    const q = trpc.presence.myAvailability as unknown as { query: () => Promise<PresenceRow | null> };
    return q.query();
  }, [trpc]);

  useEffect(() => {
    cancelled.current = false;
    if (!hasSession) {
      setLoaded(true);
      return;
    }
    load()
      .then((row) => {
        if (cancelled.current) return;
        setCurrent(row);
        setSelected(row?.availability ?? null);
        setNote(row?.note ?? "");
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled.current) setLoaded(true);
      });
    return () => {
      cancelled.current = true;
    };
  }, [hasSession, load]);

  const save = useCallback(
    async (availability: Availability | null) => {
      setBusy(true);
      const m = trpc.presence.setAvailability as unknown as {
        mutate: (i: { availability: Availability | null; note?: string | null }) => Promise<PresenceRow>;
      };
      try {
        const row = await m.mutate({
          availability,
          note: availability ? note.trim() || null : null,
        });
        if (cancelled.current) return;
        setCurrent(row.availability ? row : null);
        setSelected(row.availability);
        if (!row.availability) setNote("");
      } catch {
        /* transient — leave the UI as-is so the user can retry */
      } finally {
        if (!cancelled.current) setBusy(false);
      }
    },
    [trpc, note],
  );

  // Occupy the slot to avoid a layout jump, but render nothing meaningful until loaded / signed in.
  if (!hasSession || !loaded) return null;

  const isActive = !!current?.availability;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: "var(--space-2)",
        }}
      >
        {t("yourStatus")}
      </div>

      <div style={{ fontSize: 13.5, color: "var(--ink-2)", marginBottom: "var(--space-3)", lineHeight: 1.45 }}>
        {isActive ? t("activeNote") : t("choosePrompt")}
      </div>

      {/* State chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        {OPTIONS.map((opt) => {
          const on = selected === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => setSelected(on ? null : opt)}
              aria-pressed={on}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 12px",
                borderRadius: 999,
                border: on ? "1px solid var(--crimson-500, #d1466b)" : "1px solid var(--line)",
                background: on ? "var(--crimson-tint)" : "var(--paper)",
                color: on ? "var(--crimson-700)" : "var(--ink)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: DOT[opt], flexShrink: 0 }} />
              {t(`labels.${opt}`)}
            </button>
          );
        })}
      </div>

      {/* Disclosure: "free to meet" is the signal that triggers proximity pings to nearby friends. */}
      {selected === "free_to_meet" ? (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12.5, color: "var(--muted)", marginBottom: "var(--space-3)", lineHeight: 1.4 }}>
          <Icon name="locate" size={14} />
          <span>{t("alertHint")}</span>
        </div>
      ) : null}

      {/* Optional note — only relevant when a state is chosen */}
      {selected ? (
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          maxLength={NOTE_MAX}
          placeholder={t("notePlaceholder")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "9px 12px",
            borderRadius: "var(--r-md)",
            border: "1px solid var(--line)",
            background: "var(--paper)",
            color: "var(--ink)",
            fontSize: 14,
            marginBottom: "var(--space-3)",
          }}
        />
      ) : null}

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Button variant="pri" size="sm" disabled={busy || !selected} onClick={() => selected && void save(selected)}>
          {busy ? t("saving") : isActive ? t("update") : t("share")}
        </Button>
        {isActive ? (
          <button
            type="button"
            onClick={() => void save(null)}
            disabled={busy}
            style={{
              all: "unset",
              cursor: busy ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--muted)",
              padding: "8px 10px",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {t("clear")}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

/** Small inline pill shown next to a friend who currently has a live status. Reused in FriendsList. */
export function PresencePill({ availability, note }: { availability: Availability; note: string | null }) {
  const t = useTranslations("presence");
  return (
    <span
      title={note ?? undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: 999,
        background: "var(--paper-2)",
        border: "1px solid var(--line)",
        fontSize: 11.5,
        fontWeight: 600,
        color: "var(--ink-2)",
        flexShrink: 0,
        maxWidth: 200,
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: DOT[availability], flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {note && note.trim() ? note.trim() : t(`labels.${availability}`)}
      </span>
    </span>
  );
}
