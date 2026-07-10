/**
 * ChatShareMenu — the composer's "+" attachment menu (WhatsApp-style) for sharing a Venue, a Plan,
 * or a person into the chat. Selecting one opens a picker; picking calls onShare(kind, payload) with
 * a snapshot the server validates (@roam/core.validateMessage). Photos arrive in Phase 2 — the menu
 * leaves room for them. Pure UI over existing reads: venues.near, plans.list, social.myFriends.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, Icon, type IconName } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { PLACES, DEFAULT_PLACE, type Place } from "./PlaceSwitcher";
import type { MessageKind } from "../lib/chatKinds";
import { uploadChatImage } from "../lib/uploadChatImage";

type ShareTarget = "venue" | "plan" | "person";

export function ChatShareMenu({
  threadId,
  onShare,
  disabled,
}: {
  threadId: string;
  onShare: (kind: MessageKind, payload: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("chatShareMenu");
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState<ShareTarget | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const choose = useCallback(
    (kind: MessageKind, payload: Record<string, unknown>) => {
      onShare(kind, payload);
      setPicker(null);
    },
    [onShare],
  );

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file later
      if (!file) return;
      setUploading(true);
      setUploadError(null);
      try {
        const up = await uploadChatImage(threadId, file);
        onShare("image", { path: up.path, width: up.width, height: up.height, mime: up.mime });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : t("errors.uploadPhoto"));
      } finally {
        setUploading(false);
      }
    },
    [threadId, onShare],
  );

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={(e) => void onFile(e)}
        style={{ display: "none" }}
      />
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        disabled={disabled || uploading}
        aria-label={t("shareSomethingAria")}
        title={t("shareTitle")}
        style={{
          all: "unset",
          cursor: disabled ? "default" : "pointer",
          width: 40,
          height: 40,
          flex: "0 0 auto",
          display: "grid",
          placeItems: "center",
          borderRadius: 12,
          border: "1px solid var(--line-2)",
          background: "#fff",
          color: "var(--ink)",
          fontSize: 22,
          lineHeight: 1,
          opacity: disabled || uploading ? 0.5 : 1,
        }}
      >
        {uploading ? "…" : <Icon name="plus" size={22} />}
      </button>

      {menuOpen ? (
        <>
          {/* click-away scrim */}
          <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", bottom: 56, left: 0, zIndex: 41 }}>
            <Card style={{ padding: 6, minWidth: 180, boxShadow: "var(--sh-2)" }}>
              <MenuItem icon="place" label={t("sharePlace")} onClick={() => { setPicker("venue"); setMenuOpen(false); }} />
              <MenuItem icon="plan" label={t("sharePlan")} onClick={() => { setPicker("plan"); setMenuOpen(false); }} />
              <MenuItem icon="person" label={t("sharePerson")} onClick={() => { setPicker("person"); setMenuOpen(false); }} />
              <MenuItem icon="poll" label={t("poll")} onClick={() => { setPollOpen(true); setMenuOpen(false); }} />
              <MenuItem icon="photo" label={t("photo")} onClick={() => { setMenuOpen(false); fileRef.current?.click(); }} />
            </Card>
          </div>
        </>
      ) : null}

      {uploadError ? (
        <div role="alert" style={{ position: "absolute", bottom: 48, left: 0, background: "var(--crimson-tint)", color: "var(--crimson-700)", border: "1px solid var(--crimson-tint-2)", borderRadius: 8, padding: "6px 10px", fontSize: 12.5, whiteSpace: "nowrap", zIndex: 41 }}>
          {uploadError}
        </div>
      ) : null}

      {picker ? (
        <PickerModal title={pickerTitle(t, picker)} onClose={() => setPicker(null)}>
          {picker === "venue" ? <VenuePicker onPick={(v) => choose("venue_card", { venueId: v.id, name: v.name })} /> : null}
          {picker === "plan" ? <PlanPicker onPick={(p) => choose("plan_card", { planId: p.id, title: p.title })} /> : null}
          {picker === "person" ? <PersonPicker onPick={(f) => choose("profile_card", { profileId: f.id, name: f.name, handle: f.handle })} /> : null}
        </PickerModal>
      ) : null}

      {pollOpen ? (
        <PickerModal title={t("createPollTitle")} onClose={() => setPollOpen(false)}>
          <PollCreator onCreate={(payload) => { onShare("poll", payload); setPollOpen(false); }} />
        </PickerModal>
      ) : null}
    </>
  );
}

function pickerTitle(t: ReturnType<typeof useTranslations>, target: ShareTarget): string {
  return target === "venue" ? t("sharePlace") : target === "plan" ? t("sharePlan") : t("sharePerson");
}

function MenuItem({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, fontFamily: "var(--ui)", fontSize: 14, color: "var(--ink)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--paper-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={icon} size={18} style={{ color: "var(--crimson-700)" }} />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ modal shell */

function PickerModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const t = useTranslations("chatShareMenu");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "start center", padding: "var(--space-8) var(--space-3)", background: "rgba(20,14,16,.55)", overflowY: "auto" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 440 }}>
        <Card style={{ padding: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
            <h2 style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: 0, color: "var(--ink)" }}>{title}</h2>
            <button type="button" onClick={onClose} aria-label={t("close")} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", padding: 4, display: "inline-flex" }}><Icon name="close" size={18} /></button>
          </div>
          {children}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pickers */

interface VenueRow { id: string; name: string }

function VenuePicker({ onPick }: { onPick: (v: VenueRow) => void }) {
  const t = useTranslations("chatShareMenu");
  const trpc = useTrpc();
  const [place, setPlace] = useState<Place>(DEFAULT_PLACE);
  const [venues, setVenues] = useState<VenueRow[] | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setVenues(undefined);
    trpc.venues.near
      .query({ lat: place.lat, lng: place.lng, limit: 50 })
      .then((rows) => { if (!cancelled) setVenues(rows as VenueRow[]); })
      .catch(() => { if (!cancelled) setVenues(null); });
    return () => { cancelled = true; };
  }, [place, trpc]);

  return (
    <>
      <div style={{ display: "flex", gap: 6, marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
        {PLACES.map((p) => (
          <Button key={p.id} variant={p.id === place.id ? "pri" : "neutral"} size="sm" onClick={() => setPlace(p)}>
            {p.name}
          </Button>
        ))}
      </div>
      {venues === undefined ? (
        <Muted>{t("venuesLoading", { place: place.name })}</Muted>
      ) : venues === null ? (
        <Muted>{t("venuesLoadFailed")}</Muted>
      ) : venues.length === 0 ? (
        <Muted>{t("venuesEmpty", { place: place.name })}</Muted>
      ) : (
        <div style={{ display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {venues.map((v) => (
            <Button key={v.id} variant="neutral" onClick={() => onPick(v)} style={{ justifyContent: "flex-start" }}>
              <Icon name="place" size={15} /> {v.name}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

interface PlanRow { id: string; title: string }

function PlanPicker({ onPick }: { onPick: (p: PlanRow) => void }) {
  const t = useTranslations("chatShareMenu");
  const trpc = useTrpc();
  const [plans, setPlans] = useState<PlanRow[] | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.plans.list as unknown as { query: () => Promise<{ plans: PlanRow[] }> };
    q.query()
      .then((r) => { if (!cancelled) setPlans(r.plans ?? []); })
      .catch(() => { if (!cancelled) setPlans(null); });
    return () => { cancelled = true; };
  }, [trpc]);

  if (plans === undefined) return <Muted>{t("plansLoading")}</Muted>;
  if (plans === null) return <Muted>{t("plansLoadFailed")}</Muted>;
  if (plans.length === 0) return <Muted>{t("plansEmpty")}</Muted>;
  return (
    <div style={{ display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
      {plans.map((p) => (
        <Button key={p.id} variant="neutral" onClick={() => onPick(p)} style={{ justifyContent: "flex-start" }}>
          <Icon name="plan" size={15} /> {p.title}
        </Button>
      ))}
    </div>
  );
}

interface PersonRow { id: string; name: string; handle: string | null }

function PersonPicker({ onPick }: { onPick: (f: PersonRow) => void }) {
  const t = useTranslations("chatShareMenu");
  const trpc = useTrpc();
  const [people, setPeople] = useState<PersonRow[] | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.social.myFriends as unknown as {
      query: () => Promise<{ ok: boolean; friends?: { id: string; handle: string | null; displayName: string | null }[] }>;
    };
    q.query()
      .then((r) => {
        if (cancelled) return;
        const friends = (r.ok ? r.friends ?? [] : []).map((f) => ({
          id: f.id,
          name: f.displayName?.trim() || (f.handle ? `@${f.handle}` : t("roamMember")),
          handle: f.handle,
        }));
        setPeople(friends);
      })
      .catch(() => { if (!cancelled) setPeople(null); });
    return () => { cancelled = true; };
  }, [trpc]);

  if (people === undefined) return <Muted>{t("friendsLoading")}</Muted>;
  if (people === null) return <Muted>{t("friendsLoadFailed")}</Muted>;
  if (people.length === 0) return <Muted>{t("friendsEmpty")}</Muted>;
  return (
    <div style={{ display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
      {people.map((f) => (
        <Button key={f.id} variant="neutral" onClick={() => onPick(f)} style={{ justifyContent: "flex-start" }}>
          <Icon name="person" size={15} /> {f.name}
        </Button>
      ))}
    </div>
  );
}

/** Build a poll: a question, 2–10 options, and single-vs-multi. Emits the validated payload. */
function PollCreator({ onCreate }: { onCreate: (payload: Record<string, unknown>) => void }) {
  const t = useTranslations("chatShareMenu");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<{ id: string; text: string }[]>(() => [
    { id: rid(), text: "" },
    { id: rid(), text: "" },
  ]);
  const [multi, setMulti] = useState(false);

  const setText = (id: string, text: string) => setOptions((os) => os.map((o) => (o.id === id ? { ...o, text } : o)));
  const addOption = () => setOptions((os) => (os.length >= 10 ? os : [...os, { id: rid(), text: "" }]));
  const removeOption = (id: string) => setOptions((os) => (os.length <= 2 ? os : os.filter((o) => o.id !== id)));

  const filled = options.filter((o) => o.text.trim());
  const canCreate = question.trim().length > 0 && filled.length >= 2;

  const create = () => {
    if (!canCreate) return;
    onCreate({ question: question.trim(), options: filled.map((o) => ({ id: o.id, text: o.text.trim() })), multi });
  };

  const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 14, color: "var(--ink)", outline: "none" };

  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t("questionPlaceholder")} maxLength={300} aria-label={t("questionAria")} autoFocus style={inputStyle} />
      <div style={{ display: "grid", gap: 8 }}>
        {options.map((o, i) => (
          <div key={o.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input value={o.text} onChange={(e) => setText(o.id, e.target.value)} placeholder={t("optionN", { n: i + 1 })} maxLength={200} aria-label={t("optionN", { n: i + 1 })} style={inputStyle} />
            {options.length > 2 ? (
              <button type="button" aria-label={t("removeOption")} onClick={() => removeOption(o.id)} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", padding: "0 4px", display: "inline-flex" }}><Icon name="close" size={16} /></button>
            ) : null}
          </div>
        ))}
      </div>
      {options.length < 10 ? (
        <button type="button" onClick={addOption} style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontWeight: 600, fontSize: 13 }}>{t("addOption")}</button>
      ) : null}
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--crimson)" }} />
        <span style={{ fontSize: 13.5, color: "var(--ink)" }}>{t("allowMultiple")}</span>
      </label>
      <Button variant="pri" onClick={create} disabled={!canCreate}>{t("createPoll")}</Button>
    </div>
  );
}

function rid(): string {
  return crypto.randomUUID();
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{children}</p>;
}
