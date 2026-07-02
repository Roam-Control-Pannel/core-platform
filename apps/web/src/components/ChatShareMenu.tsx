/**
 * ChatShareMenu — the composer's "+" attachment menu (WhatsApp-style) for sharing a Venue, a Plan,
 * or a person into the chat. Selecting one opens a picker; picking calls onShare(kind, payload) with
 * a snapshot the server validates (@roam/core.validateMessage). Photos arrive in Phase 2 — the menu
 * leaves room for them. Pure UI over existing reads: venues.near, plans.list, social.myFriends.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card } from "@roam/design";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState<ShareTarget | null>(null);
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
        setUploadError(err instanceof Error ? err.message : "Couldn't upload that photo.");
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
        aria-label="Share something"
        title="Share a place, plan, person or photo"
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
        {uploading ? "…" : "+"}
      </button>

      {menuOpen ? (
        <>
          {/* click-away scrim */}
          <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", bottom: 56, left: 0, zIndex: 41 }}>
            <Card style={{ padding: 6, minWidth: 180, boxShadow: "var(--sh-2)" }}>
              <MenuItem icon="📍" label="Share a place" onClick={() => { setPicker("venue"); setMenuOpen(false); }} />
              <MenuItem icon="🗓" label="Share a plan" onClick={() => { setPicker("plan"); setMenuOpen(false); }} />
              <MenuItem icon="👤" label="Share a person" onClick={() => { setPicker("person"); setMenuOpen(false); }} />
              <MenuItem icon="📷" label="Photo" onClick={() => { setMenuOpen(false); fileRef.current?.click(); }} />
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
        <PickerModal title={pickerTitle(picker)} onClose={() => setPicker(null)}>
          {picker === "venue" ? <VenuePicker onPick={(v) => choose("venue_card", { venueId: v.id, name: v.name })} /> : null}
          {picker === "plan" ? <PlanPicker onPick={(p) => choose("plan_card", { planId: p.id, title: p.title })} /> : null}
          {picker === "person" ? <PersonPicker onPick={(f) => choose("profile_card", { profileId: f.id, name: f.name, handle: f.handle })} /> : null}
        </PickerModal>
      ) : null}
    </>
  );
}

function pickerTitle(t: ShareTarget): string {
  return t === "venue" ? "Share a place" : t === "plan" ? "Share a plan" : "Share a person";
}

function MenuItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, fontFamily: "var(--ui)", fontSize: 14, color: "var(--ink)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--paper-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span aria-hidden style={{ fontSize: 18 }}>{icon}</span>
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ modal shell */

function PickerModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
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
            <button type="button" onClick={onClose} aria-label="Close" style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 18, padding: 4 }}>✕</button>
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
        <Muted>Loading venues near {place.name}…</Muted>
      ) : venues === null ? (
        <Muted>Couldn&apos;t load venues.</Muted>
      ) : venues.length === 0 ? (
        <Muted>No venues near {place.name} yet.</Muted>
      ) : (
        <div style={{ display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {venues.map((v) => (
            <Button key={v.id} variant="neutral" onClick={() => onPick(v)} style={{ justifyContent: "flex-start" }}>
              📍 {v.name}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

interface PlanRow { id: string; title: string }

function PlanPicker({ onPick }: { onPick: (p: PlanRow) => void }) {
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

  if (plans === undefined) return <Muted>Loading your plans…</Muted>;
  if (plans === null) return <Muted>Couldn&apos;t load your plans.</Muted>;
  if (plans.length === 0) return <Muted>You have no plans yet. Create one from the Plans tab, then share it here.</Muted>;
  return (
    <div style={{ display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
      {plans.map((p) => (
        <Button key={p.id} variant="neutral" onClick={() => onPick(p)} style={{ justifyContent: "flex-start" }}>
          🗓 {p.title}
        </Button>
      ))}
    </div>
  );
}

interface PersonRow { id: string; name: string; handle: string | null }

function PersonPicker({ onPick }: { onPick: (f: PersonRow) => void }) {
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
          name: f.displayName?.trim() || (f.handle ? `@${f.handle}` : "Roam member"),
          handle: f.handle,
        }));
        setPeople(friends);
      })
      .catch(() => { if (!cancelled) setPeople(null); });
    return () => { cancelled = true; };
  }, [trpc]);

  if (people === undefined) return <Muted>Loading friends…</Muted>;
  if (people === null) return <Muted>Couldn&apos;t load your friends.</Muted>;
  if (people.length === 0) return <Muted>No friends yet. Add friends from their profile walls, then share them here.</Muted>;
  return (
    <div style={{ display: "grid", gap: 6, maxHeight: 320, overflowY: "auto" }}>
      {people.map((f) => (
        <Button key={f.id} variant="neutral" onClick={() => onPick(f)} style={{ justifyContent: "flex-start" }}>
          👤 {f.name}
        </Button>
      ))}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>{children}</p>;
}
