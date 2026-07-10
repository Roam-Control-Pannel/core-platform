/**
 * VenueNotify — "Send a notification" on the business dashboard. The owner writes a short message
 * and sends it to their followers' in-app inbox (the bell), either to ALL of them collectively or
 * to ONE specific follower. Backed by notifications.sendToFollowers → send_venue_notification
 * (0042, SECURITY DEFINER, owner-gated). Individual sends only reach real followers.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Seg } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

interface Follower {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function followerName(t: ReturnType<typeof useTranslations>, f: Follower): string {
  if (f.displayName && f.displayName.trim()) return f.displayName.trim();
  if (f.handle && f.handle.trim()) return `@${f.handle.trim()}`;
  return t("roamMember");
}

const MAX = 500;

export function VenueNotify({ venueId }: { venueId: string }) {
  const t = useTranslations("venueNotify");
  const trpc = useTrpc();
  const [count, setCount] = useState<number | null>(null);
  const [followers, setFollowers] = useState<Follower[]>([]);
  const [mode, setMode] = useState<"all" | "one">("all");
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const vf = trpc.social.venueFollowers as unknown as { query: (i: { venueId: string; limit: number }) => Promise<{ ok: boolean; count: number; followers: Follower[] }> };
    vf.query({ venueId, limit: 50 })
      .then((r) => { if (!cancelled) { setCount(r.count ?? 0); setFollowers(r.followers ?? []); } })
      .catch(() => { if (!cancelled) { setCount(0); setFollowers([]); } });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body) { setError(t("errors.emptyMessage")); return; }
    if (mode === "one" && !recipientId) { setError(t("errors.noRecipient")); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    const mut = trpc.notifications.sendToFollowers as unknown as {
      mutate: (i: { venueId: string; text: string; recipientId?: string }) => Promise<{ sent: number }>;
    };
    try {
      const res = await mut.mutate({ venueId, text: body, ...(mode === "one" && recipientId ? { recipientId } : {}) });
      setText("");
      setResult(res.sent === 0 ? t("noneNotified") : t("sentTo", { count: res.sent }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.sendFailed"));
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, text, mode, recipientId]);

  if (count === 0) {
    return (
      <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5 }}>
        {t("noFollowers")}
      </p>
    );
  }

  return (
    <div>
      <Seg
        options={[
          { value: "all", label: count != null ? t("allFollowersCount", { count }) : t("allFollowers") },
          { value: "one", label: t("onePerson") },
        ]}
        value={mode}
        onChange={(v) => { setMode(v as "all" | "one"); setResult(null); setError(null); }}
      />

      {mode === "one" ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
            {t("to")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {followers.map((f) => {
              const on = recipientId === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setRecipientId(on ? null : f.id)}
                  style={{
                    all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7,
                    padding: "4px 12px 4px 5px", borderRadius: 999,
                    background: on ? "var(--crimson)" : "var(--paper-2)",
                    border: `1px solid ${on ? "var(--crimson)" : "var(--line)"}`,
                    color: on ? "#fff" : "var(--ink)",
                  }}
                >
                  <Avatar f={f} size={22} on={on} />
                  <span style={{ fontSize: 13, fontWeight: 600, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{followerName(t, f)}</span>
                </button>
              );
            })}
          </div>
          {count != null && count > followers.length ? (
            <p style={{ margin: "var(--space-2) 2px 0", fontSize: 11.5, color: "var(--muted)" }}>
              {t("showingRecent", { count: followers.length })}
            </p>
          ) : null}
        </div>
      ) : null}

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value.slice(0, MAX)); setResult(null); }}
        placeholder={mode === "one" ? t("placeholderOne") : t("placeholderAll")}
        aria-label={t("messageAria")}
        rows={3}
        style={{
          width: "100%", boxSizing: "border-box", marginTop: "var(--space-3)", padding: "10px 12px",
          background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)",
          fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none", resize: "vertical", minHeight: 76,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void send()} disabled={busy || text.trim().length === 0 || (mode === "one" && !recipientId)}>
          {busy ? t("sending") : mode === "one" ? t("send") : count != null ? t("sendToAllCount", { count }) : t("sendToAll")}
        </Button>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{text.length}/{MAX}</span>
        {result ? <span style={{ fontSize: 13, color: "var(--success)" }}>{result}</span> : null}
        {error ? <span role="alert" style={{ fontSize: 13, color: "var(--crimson-700)" }}>{error}</span> : null}
      </div>
      <p style={{ margin: "var(--space-3) 2px 0", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        {t("footer")}
      </p>
    </div>
  );
}

function Avatar({ f, size, on }: { f: Follower; size: number; on: boolean }) {
  const t = useTranslations("venueNotify");
  if (f.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={f.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: on ? "rgba(255,255,255,.25)" : "var(--crimson-tint)", color: on ? "#fff" : "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {followerName(t, f).replace(/^@/, "").charAt(0).toUpperCase() || "·"}
    </span>
  );
}
