/**
 * OwnerMediaManager — the venue owner's photo management surface.
 *
 * Mounted by VenueDetail's ClaimedDetail ONLY when the viewer owns the venue
 * (session.user.id === venue.owner_id). A non-owner never sees it; the public gallery
 * (VenuePhotos) is unchanged for everyone.
 *
 * The owner control surface for Slice 6:
 *   - UPLOAD: file picked → client-validated (type/size) → uploaded straight to the
 *     PUBLIC `venue-media` Storage bucket via the browser Supabase SDK under the owner's
 *     JWT (the 0021 storage RLS authorises the write by venue-id path prefix) → then
 *     venues.addOwnerPhoto records the metadata row (itself RLS-gated, 0019).
 *   - REORDER: up/down nudge per owner photo → venues.reorderPhotos writes positions.
 *   - SET COVER: pick the hero → venues.setCover (clear-then-set; one-cover index, 0019).
 *   - ALT TEXT + REMOVE: handled inline per row (remove deletes object then row).
 *
 * The API is a metadata plane: bytes go browser→Storage directly; this component never
 * routes a file through the API. One auth model (Postgres RLS) guards both bytes and rows.
 *
 * google_places rows are shown READ-ONLY ("from public sources") — owners can't edit
 * scraped provenance (the 0019 immutability rule), but seeing them is what an owner needs
 * to decide what to upload. Owner uploads always outrank scraped in the public render
 * (selectHero/galleryOrder, owner > places), so an uploaded photo takes over automatically.
 *
 * Design system only: Card / Button / Pill from @roam/design, var(--*) tokens. No invented
 * styles. One crimson (variant="pri") CTA — the upload action — per the usage rule.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Button, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { getSupabaseBrowser } from "../lib/supabase";

/** The Storage bucket owner uploads land in (migration 0021). Mirror of the API const. */
const VENUE_MEDIA_BUCKET = "venue-media";

/** Client-side upload guards — UX-fast feedback. Storage RE-enforces these at the edge
 *  (allowed_mime_types + file_size_limit on the 0021 bucket), so these are the friendly
 *  first line, not the security boundary. Kept in lockstep with the bucket config. */
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — matches the bucket file_size_limit.

/** A managed photo row — the manageable subset of venue_photos this surface reads. */
interface ManagedPhotoRow {
  id: string;
  source: "google_places" | "owner_upload";
  position: number;
  is_cover: boolean;
  storage_path: string | null;
  alt_text?: string | null;
}

/** Loosely-typed tRPC surfaces (TS2589 dodge — the same idiom VenueDetail uses). */
interface PhotosByVenueQuery {
  query: (input: { venueId: string }) => Promise<ManagedPhotoRow[]>;
}
interface AddOwnerPhotoMutation {
  mutate: (input: {
    venueId: string;
    storagePath: string;
    altText?: string;
    width?: number;
    height?: number;
    position?: number;
  }) => Promise<{ ok: boolean; photoId?: string; position?: number }>;
}
interface ReorderPhotosMutation {
  mutate: (input: { venueId: string; orderedPhotoIds: string[] }) => Promise<{
    ok: boolean;
    updated: number;
    requested: number;
  }>;
}
interface SetCoverMutation {
  mutate: (input: { venueId: string; photoId: string | null }) => Promise<{
    ok: boolean;
    cover: string | null;
  }>;
}
interface RemoveOwnerPhotoMutation {
  mutate: (input: { photoId: string }) => Promise<{ ok: boolean; deleted: boolean }>;
}

export function OwnerMediaManager({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [rows, setRows] = useState<ManagedPhotoRow[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /** Reload the venue's photo rows (owner + places). Single source of truth = server. */
  const reload = useCallback(async () => {
    const photosByVenue = trpc.venues.photosByVenue as unknown as PhotosByVenueQuery;
    const res = await photosByVenue.query({ venueId });
    return Array.isArray(res) ? res : [];
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    reload()
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]); // a load failure shows the empty manager, not a crash
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /** Read an image file's natural dimensions (best-effort; undefined on failure). */
  const readDimensions = useCallback(
    (file: File): Promise<{ width?: number; height?: number }> =>
      new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
          URL.revokeObjectURL(url);
        };
        img.onerror = () => {
          resolve({});
          URL.revokeObjectURL(url);
        };
        img.src = url;
      }),
    [],
  );

  /** Handle a picked file: validate → SDK upload → record row → reload. */
  const onFilePicked = useCallback(
    async (file: File) => {
      setError(null);

      // Client-side guards (Storage re-enforces both at the edge).
      if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
        setError("Please choose a JPEG, PNG or WebP image.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError("That image is over 10 MB. Please choose a smaller file.");
        return;
      }

      setBusy(true);
      try {
        // Object path MUST start with the venue id — the 0021 storage RLS extracts the
        // first path segment and checks venue ownership. A safe, unique filename avoids
        // collisions; we keep the original extension for the MIME match.
        const ext = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
        const filename = `${crypto.randomUUID()}.${ext}`;
        const storagePath = `${venueId}/${filename}`;

        const supabase = getSupabaseBrowser();
        const { error: upErr } = await supabase.storage
          .from(VENUE_MEDIA_BUCKET)
          .upload(storagePath, file, {
            contentType: file.type,
            upsert: false,
          });
        if (upErr) {
          // RLS refusal, MIME/size rejection, or network — all land here.
          setError(`Upload failed: ${upErr.message}`);
          return;
        }

        const { width, height } = await readDimensions(file);

        const addOwnerPhoto = trpc.venues.addOwnerPhoto as unknown as AddOwnerPhotoMutation;
        const result = await addOwnerPhoto.mutate({
          venueId,
          storagePath,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        });
        if (!result.ok) {
          // Bytes landed but the row write was RLS-refused (shouldn't happen for the
          // owner, but we surface it honestly rather than show a phantom success).
          setError("Uploaded, but couldn't save the photo. Please try again.");
          return;
        }
        setRows(await reload());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = ""; // allow re-picking the same file
      }
    },
    [trpc, venueId, reload, readDimensions],
  );

  /** Move an owner photo up/down within the owner block, then persist the new order. */
  const move = useCallback(
    async (photoId: string, dir: -1 | 1) => {
      if (!rows) return;
      const owner = rows
        .filter((r) => r.source === "owner_upload")
        .sort((a, b) => a.position - b.position);
      const idx = owner.findIndex((r) => r.id === photoId);
      const swapWith = idx + dir;
      if (idx < 0 || swapWith < 0 || swapWith >= owner.length) return;

      // Swap locally for an optimistic reorder, then persist the full ordered id list.
      const reordered = [...owner];
      const tmp = reordered[idx]!;
      reordered[idx] = reordered[swapWith]!;
      reordered[swapWith] = tmp;

      // Apply the swap to local state immediately so the arrows feel instant — the two
      // moved photos trade `position` values (the render sorts owner photos by position),
      // and reload() below reconciles with server truth once the write lands.
      const a = owner[idx]!;
      const b = owner[swapWith]!;
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.id === a.id
                ? { ...r, position: b.position }
                : r.id === b.id
                  ? { ...r, position: a.position }
                  : r,
            )
          : prev,
      );

      setBusy(true);
      setError(null);
      try {
        const reorderPhotos = trpc.venues.reorderPhotos as unknown as ReorderPhotosMutation;
        const res = await reorderPhotos.mutate({
          venueId,
          orderedPhotoIds: reordered.map((r) => r.id),
        });
        if (!res.ok) setError("Couldn't save the new order. Please try again.");
        setRows(await reload());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Couldn't reorder.");
      } finally {
        setBusy(false);
      }
    },
    [rows, trpc, venueId, reload],
  );

  /** Set (or clear) the cover photo. */
  const setCover = useCallback(
    async (photoId: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const setCoverMut = trpc.venues.setCover as unknown as SetCoverMutation;
        const res = await setCoverMut.mutate({ venueId, photoId });
        if (!res.ok) setError("Couldn't set the cover. Please try again.");
        setRows(await reload());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Couldn't set cover.");
      } finally {
        setBusy(false);
      }
    },
    [trpc, venueId, reload],
  );

  /** Remove an owner photo (object then row). */
  const remove = useCallback(
    async (photoId: string) => {
      setBusy(true);
      setError(null);
      try {
        const removeMut = trpc.venues.removeOwnerPhoto as unknown as RemoveOwnerPhotoMutation;
        const res = await removeMut.mutate({ photoId });
        if (!res.ok) setError("Couldn't remove that photo. Please try again.");
        setRows(await reload());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Couldn't remove.");
      } finally {
        setBusy(false);
      }
    },
    [trpc, reload],
  );

  const ownerRows = (rows ?? [])
    .filter((r) => r.source === "owner_upload")
    .sort((a, b) => a.position - b.position);
  const placesRows = (rows ?? [])
    .filter((r) => r.source === "google_places")
    .sort((a, b) => a.position - b.position);

  return (
    <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: "var(--space-3)",
        }}
      >
        Manage photos
      </div>

      <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
        Upload your own photos — they take priority over photos from public sources. Set a
        cover to choose what people see first, and drag the order with the arrows.
      </p>

      {/* Hidden native file input, driven by the crimson primary CTA. */}
      <input
        ref={fileRef}
        type="file"
        accept={ALLOWED_MIME.join(",")}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFilePicked(f);
        }}
      />

      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
        <Button
          variant="pri"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Working…" : "Upload a photo"}
        </Button>
        {ownerRows.length === 0 ? (
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>No photos uploaded yet.</span>
        ) : null}
      </div>

      {error ? (
        <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-3)" }} role="alert">
          {error}
        </div>
      ) : null}

      {/* Owner uploads — the manageable set. */}
      {ownerRows.length > 0 ? (
        <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
          {ownerRows.map((row, i) => (
            <OwnerPhotoRow
              key={row.id}
              row={row}
              isFirst={i === 0}
              isLast={i === ownerRows.length - 1}
              busy={busy}
              onUp={() => void move(row.id, -1)}
              onDown={() => void move(row.id, 1)}
              onSetCover={() => void setCover(row.is_cover ? null : row.id)}
              onRemove={() => void remove(row.id)}
            />
          ))}
        </div>
      ) : null}

      {/* Scraped photos — read-only provenance context. */}
      {placesRows.length > 0 ? (
        <div style={{ marginTop: "var(--space-5)" }}>
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
            From public sources ({placesRows.length})
          </div>
          <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, margin: 0 }}>
            These come from public listings and can&apos;t be edited here. Upload your own
            photos above to show them first.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/** A single owner-photo management row: thumbnail + cover toggle + reorder + remove. */
function OwnerPhotoRow({
  row,
  isFirst,
  isLast,
  busy,
  onUp,
  onDown,
  onSetCover,
  onRemove,
}: {
  row: ManagedPhotoRow;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onSetCover: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-2)",
        border: "1px solid var(--line-2)",
        borderRadius: 12,
        background: "#fff",
      }}
    >
      <div style={{ flex: "0 0 auto", width: 64, height: 48, borderRadius: 8, overflow: "hidden" }}>
        <OwnerThumb photoId={row.id} />
      </div>

      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        {row.is_cover ? (
          <Pill variant="ghost-crim" size="sm">
            Cover
          </Pill>
        ) : (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Photo</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Button variant="neutral" size="sm" disabled={busy || isFirst} onClick={onUp} aria-label="Move up">
          ↑
        </Button>
        <Button variant="neutral" size="sm" disabled={busy || isLast} onClick={onDown} aria-label="Move down">
          ↓
        </Button>
        <Button variant="neutral" size="sm" disabled={busy} onClick={onSetCover}>
          {row.is_cover ? "Unset cover" : "Set cover"}
        </Button>
        <Button variant="neutral" size="sm" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

/**
 * OwnerThumb — resolves an owner photo to its public URL via venues.photoMediaUrl (the
 * same resolver the public gallery uses; the owner branch returns the public CDN URL).
 * A plain <img>: the owner-upload public URL is stable and CDN-cacheable, so unlike the
 * Places branch there's no TTL concern — but we keep <img> (not next/image) for parity
 * with VenuePhoto and to avoid the optimizer caching a URL we may delete.
 */
function OwnerThumb({ photoId }: { photoId: string }) {
  const trpc = useTrpc();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const photoMediaUrl = trpc.venues.photoMediaUrl as unknown as {
      query: (input: { photoId: string }) => Promise<{ url: string }>;
    };
    photoMediaUrl
      .query({ photoId })
      .then((res) => {
        if (!cancelled) setUrl(res?.url ?? null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, photoId]);

  if (!url) {
    return <div style={{ width: "100%", height: "100%", background: "var(--crimson-tint)" }} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}
