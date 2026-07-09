/**
 * ProfileEditor — the signed-in user's editable profile (display name, handle, bio, avatar,
 * header, social links). Loads profiles.me, edits locally, persists via profiles.updateMe.
 *
 * Images: picked files upload straight to the public profile-media bucket (uploadProfileImage,
 * RLS-gated to the user's own folder) and the returned public URL goes into local state; the
 * single Save writes everything (name/handle/bio/urls/links) in one updateMe. The handle is
 * unique — a clash comes back as a friendly CONFLICT and is shown inline.
 *
 * Styling follows the app convention: inline styles + design tokens, native inputs, ONE
 * crimson (Button variant="pri") primary action — Save.
 */
"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { uploadProfileImage } from "../lib/uploadProfileImage";
import { ImageCropper } from "./ImageCropper";

/** The social platforms we offer as labelled URL fields. Stored as a flat label→url map. */
const SOCIAL_FIELDS = ["Website", "Instagram", "X", "Facebook", "TikTok", "YouTube"] as const;

const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid var(--line)",
  borderRadius: 10,
  background: "#fff",
  color: "var(--ink)",
  fontFamily: "var(--ui)",
  fontSize: 16, // ≥16px: no iOS zoom on focus
  outline: "none",
};
const labelStyle: CSSProperties = {
  display: "block",
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: 6,
};
const fieldWrap: CSSProperties = { marginBottom: "var(--space-4)" };

interface ProfileState {
  displayName: string;
  handle: string;
  bio: string;
  avatarUrl: string | null;
  headerUrl: string | null;
  links: Record<string, string>;
}

type MeQuery = {
  query: () => Promise<{
    displayName: string | null;
    handle: string | null;
    bio: string | null;
    avatarUrl: string | null;
    headerUrl: string | null;
    socialLinks: Record<string, string>;
  }>;
};
type UpdateMeMutation = {
  mutate: (input: {
    displayName: string | null;
    handle: string | null;
    bio: string | null;
    avatarUrl: string | null;
    headerUrl: string | null;
    socialLinks: Record<string, string> | null;
  }) => Promise<{ ok: boolean }>;
};
type CheckHandleQuery = {
  query: (input: { handle: string }) => Promise<{ available: boolean; normalized: string | null; reason?: string }>;
};

/** Live availability state for the handle field. */
type HandleCheck = { status: "idle" | "checking" | "ok" | "bad"; reason?: string };

export function ProfileEditor({ userId, onSaved }: { userId: string; onSaved?: () => void }) {
  const trpc = useTrpc();
  const [state, setState] = useState<ProfileState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<null | "avatar" | "header">(null);
  const [handleCheck, setHandleCheck] = useState<HandleCheck>({ status: "idle" });
  // The handle the profile loaded with — an unchanged handle is always valid (and skips the
  // network check), so editing other fields never reports your own handle as taken.
  const loadedHandleRef = useRef<string>("");

  // Load the profile once per identity.
  useEffect(() => {
    let cancelled = false;
    setState(null);
    setLoadError(null);
    (trpc.profiles.me as unknown as MeQuery)
      .query()
      .then((p) => {
        if (cancelled) return;
        loadedHandleRef.current = (p.handle ?? "").trim().toLowerCase();
        setState({
          displayName: p.displayName ?? "",
          handle: p.handle ?? "",
          bio: p.bio ?? "",
          avatarUrl: p.avatarUrl,
          headerUrl: p.headerUrl,
          links: p.socialLinks ?? {},
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Couldn't load your profile.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, userId]);

  // Live, debounced handle availability — only when it differs from the loaded handle.
  const handleValue = state?.handle ?? null;
  useEffect(() => {
    if (handleValue === null) return;
    const h = handleValue.trim().toLowerCase();
    if (h === loadedHandleRef.current) {
      setHandleCheck({ status: "ok" });
      return;
    }
    if (h === "") {
      setHandleCheck({ status: "bad", reason: "Choose a handle — it's your profile's web address." });
      return;
    }
    setHandleCheck({ status: "checking" });
    let cancelled = false;
    const t = setTimeout(() => {
      (trpc.profiles.checkHandle as unknown as CheckHandleQuery)
        .query({ handle: h })
        .then((r) => {
          if (cancelled) return;
          setHandleCheck(r.available ? { status: "ok" } : { status: "bad", reason: r.reason ?? "That handle isn't available." });
        })
        .catch(() => {
          if (!cancelled) setHandleCheck({ status: "idle" });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trpc, handleValue]);

  const patch = useCallback((p: Partial<ProfileState>) => {
    setSaved(false);
    setState((s) => (s ? { ...s, ...p } : s));
  }, []);

  // Picked file -> the scale-into-place cropper -> upload. The cropper hands back a file
  // already framed to the slot's aspect, so the rendered circle/banner shows exactly what
  // the user framed.
  const [pendingCrop, setPendingCrop] = useState<{ kind: "avatar" | "header"; file: File } | null>(null);

  const onPickImage = useCallback((kind: "avatar" | "header", file: File) => {
    setError(null);
    setPendingCrop({ kind, file });
  }, []);

  const uploadCropped = useCallback(
    async (kind: "avatar" | "header", file: File) => {
      setPendingCrop(null);
      setUploading(kind);
      try {
        const { url } = await uploadProfileImage(userId, file, kind);
        patch(kind === "avatar" ? { avatarUrl: url } : { headerUrl: url });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setUploading(null);
      }
    },
    [userId, patch],
  );

  const save = useCallback(async () => {
    if (!state) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const links: Record<string, string> = {};
      for (const [k, v] of Object.entries(state.links)) {
        const val = v.trim();
        if (val) links[k] = val;
      }
      const res = await (trpc.profiles.updateMe as unknown as UpdateMeMutation).mutate({
        displayName: state.displayName.trim() || null,
        handle: state.handle.trim(),
        bio: state.bio.trim() || null,
        avatarUrl: state.avatarUrl,
        headerUrl: state.headerUrl,
        socialLinks: Object.keys(links).length > 0 ? links : null,
      });
      if (!res.ok) {
        setError("Couldn't save your profile. Please try again.");
        return;
      }
      setSaved(true);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  }, [trpc, state, onSaved]);

  if (loadError) {
    return <p style={{ color: "var(--crimson-700)" }} role="alert">{loadError}</p>;
  }
  if (!state) {
    return <div style={{ height: 240, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />;
  }

  return (
    <div>
      {/* Header + avatar */}
      <div style={{ position: "relative", marginBottom: 56 }}>
        <ImageSlot
          kind="header"
          url={state.headerUrl}
          uploading={uploading === "header"}
          onPick={(f) => onPickImage("header", f)}
          style={{ height: 140, borderRadius: "var(--r-lg)" }}
        />
        <div style={{ position: "absolute", left: "var(--space-4)", bottom: -40 }}>
          <ImageSlot
            kind="avatar"
            url={state.avatarUrl}
            uploading={uploading === "avatar"}
            onPick={(f) => onPickImage("avatar", f)}
            style={{ width: 88, height: 88, borderRadius: "50%", border: "3px solid var(--card)" }}
          />
        </div>
      </div>

      {pendingCrop ? (
        <ImageCropper
          file={pendingCrop.file}
          spec={
            pendingCrop.kind === "avatar"
              ? { aspect: 1, outputWidth: 800, round: true, title: "Position your profile photo" }
              : { aspect: 3, outputWidth: 2000, title: "Position your header image" }
          }
          onCancel={() => setPendingCrop(null)}
          onCropped={(f) => void uploadCropped(pendingCrop.kind, f)}
        />
      ) : null}

      <div style={fieldWrap}>
        <label style={labelStyle} htmlFor="pf-name">Display name</label>
        <input
          id="pf-name"
          style={fieldStyle}
          value={state.displayName}
          maxLength={80}
          placeholder="Your name"
          onChange={(e) => patch({ displayName: e.target.value })}
        />
      </div>

      <div style={fieldWrap}>
        <label style={labelStyle} htmlFor="pf-handle">Handle</label>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 12, top: 11, color: "var(--muted)", fontSize: 16 }}>@</span>
          <input
            id="pf-handle"
            style={{ ...fieldStyle, paddingLeft: 26 }}
            value={state.handle}
            maxLength={30}
            placeholder="handle"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => patch({ handle: e.target.value })}
          />
        </div>
        {handleCheck.status === "checking" ? (
          <p style={{ margin: "6px 2px 0", fontSize: 12, color: "var(--muted)" }}>Checking availability…</p>
        ) : handleCheck.status === "ok" && state.handle.trim().toLowerCase() !== loadedHandleRef.current ? (
          <p style={{ margin: "6px 2px 0", fontSize: 12, color: "var(--success)" }}>@{state.handle.trim().toLowerCase()} is available ✓</p>
        ) : handleCheck.status === "bad" ? (
          <p style={{ margin: "6px 2px 0", fontSize: 12, color: "var(--crimson-700)" }} role="alert">{handleCheck.reason}</p>
        ) : (
          <p style={{ margin: "6px 2px 0", fontSize: 12, color: "var(--muted)" }}>
            Lowercase letters, numbers and underscores. This is your profile&apos;s web address.
          </p>
        )}
      </div>

      <div style={fieldWrap}>
        <label style={labelStyle} htmlFor="pf-bio">Bio</label>
        <textarea
          id="pf-bio"
          style={{ ...fieldStyle, minHeight: 96, resize: "vertical", lineHeight: 1.5 }}
          value={state.bio}
          maxLength={600}
          placeholder="A line about you and the places you love."
          onChange={(e) => patch({ bio: e.target.value })}
        />
      </div>

      <div style={fieldWrap}>
        <span style={labelStyle}>Links</span>
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {SOCIAL_FIELDS.map((label) => (
            <input
              key={label}
              style={fieldStyle}
              value={state.links[label] ?? ""}
              placeholder={`${label} URL`}
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => patch({ links: { ...state.links, [label]: e.target.value } })}
            />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void save()} disabled={busy || uploading !== null || handleCheck.status === "checking" || handleCheck.status === "bad"}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
        {saved ? <span style={{ fontSize: 13, color: "var(--success)" }}>Saved ✓</span> : null}
        {error ? <span role="alert" style={{ fontSize: 13, color: "var(--crimson-700)" }}>{error}</span> : null}
      </div>
    </div>
  );
}

/** An image slot (avatar or header) with a "Change" overlay that opens the file picker. */
function ImageSlot({
  kind,
  url,
  uploading,
  onPick,
  style,
}: {
  kind: "avatar" | "header";
  url: string | null;
  uploading: boolean;
  onPick: (file: File) => void;
  style: CSSProperties;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        background: "var(--paper-2)",
        display: "grid",
        placeItems: "center",
        cursor: "pointer",
        ...style,
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      aria-label={`Change ${kind} image`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <span style={{ fontSize: 13, color: "var(--faint)", display: "inline-flex", alignItems: "center" }}>
          {kind === "avatar" ? <Icon name="person" size={26} /> : "Add a header image"}
        </span>
      )}
      <span
        style={{
          position: "absolute",
          right: 6,
          bottom: 6,
          padding: "3px 8px",
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 600,
          color: "#fff",
          background: "rgba(33,29,26,.72)",
        }}
      >
        {uploading ? "Uploading…" : "Change"}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
