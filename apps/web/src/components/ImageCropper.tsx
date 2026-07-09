/**
 * ImageCropper — the "scale into place" step between picking a photo and uploading it.
 * A modal with a fixed-aspect frame: drag to position, wheel/slider to zoom (pinch works
 * via the slider on touch), live circular mask for round slots (avatars). Confirm renders
 * the framed region to a canvas at the slot's output size and hands back a File — callers
 * then run it through the normal upload path (which prepareImage/compresses as usual).
 *
 * Dependency-free by design (same policy as the Stripe client): ~pointer events + canvas,
 * no cropper library. Math model: the image is drawn at `disp` scale (display px per
 * natural px), positioned so its top-left sits at (x, y) relative to the frame; scale is
 * clamped to always cover the frame, x/y clamped so no edge shows through.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@roam/design";

export interface CropSpec {
  /** width / height of the crop frame (1 for square, 3 for a 3:1 banner …). */
  aspect: number;
  /** Output bitmap width in px; height derives from the aspect. */
  outputWidth: number;
  /** Show the circular mask (avatars). The OUTPUT is still square; the UI shows the circle. */
  round?: boolean;
  /** Dialog title, e.g. "Position your profile photo". */
  title: string;
}

export function ImageCropper({
  file,
  spec,
  onCancel,
  onCropped,
}: {
  file: File;
  spec: CropSpec;
  onCancel: () => void;
  onCropped: (file: File) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = exactly covers the frame; up to 4× closer
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Object URL for the picked file (revoked on unmount).
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Measure the frame once mounted (and again if the window resizes the modal).
  useEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (el) setFrame({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const coverScale = natural && frame ? Math.max(frame.w / natural.w, frame.h / natural.h) : 1;
  const disp = coverScale * zoom;
  const dispW = natural ? natural.w * disp : 0;
  const dispH = natural ? natural.h * disp : 0;

  const clamp = useCallback(
    (x: number, y: number, dW: number, dH: number) => {
      if (!frame) return { x, y };
      return {
        x: Math.min(0, Math.max(frame.w - dW, x)),
        y: Math.min(0, Math.max(frame.h - dH, y)),
      };
    },
    [frame],
  );

  // Centre the image when it first loads (and re-clamp when zoom changes).
  useEffect(() => {
    if (!natural || !frame) return;
    setPos((p) => clamp(p.x, p.y, natural.w * disp, natural.h * disp));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-clamp on zoom/layout only
  }, [zoom, natural, frame]);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    const el = frameRef.current;
    if (!img || !el) return;
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    setNatural(nat);
    const f = { w: el.clientWidth, h: el.clientHeight };
    setFrame(f);
    const cover = Math.max(f.w / nat.w, f.h / nat.h);
    setPos({ x: (f.w - nat.w * cover) / 2, y: (f.h - nat.h * cover) / 2 });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    },
    [pos],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      setPos(clamp(d.origX + (e.clientX - d.startX), d.origY + (e.clientY - d.startY), dispW, dispH));
    },
    [clamp, dispW, dispH],
  );
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  // Wheel-zoom around the frame centre.
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!frame || !natural) return;
      const next = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      if (next === zoom) return;
      const factor = (coverScale * next) / disp;
      const cx = frame.w / 2;
      const cy = frame.h / 2;
      const nx = cx - (cx - pos.x) * factor;
      const ny = cy - (cy - pos.y) * factor;
      setZoom(next);
      setPos(clamp(nx, ny, natural.w * coverScale * next, natural.h * coverScale * next));
    },
    [zoom, disp, coverScale, frame, natural, pos, clamp],
  );

  const confirm = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !natural || !frame) return;
    setBusy(true);
    setError(null);
    try {
      const outW = spec.outputWidth;
      const outH = Math.round(outW / spec.aspect);
      // Source rect (natural px) currently framed.
      const sx = -pos.x / disp;
      const sy = -pos.y / disp;
      const sw = frame.w / disp;
      const sh = frame.h / disp;
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Couldn't crop that image in this browser.");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      const finalBlob = blob ?? (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9)));
      if (!finalBlob) throw new Error("Couldn't crop that image in this browser.");
      const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "image";
      const ext = finalBlob.type === "image/webp" ? "webp" : "jpg";
      onCropped(new File([finalBlob], `${base}-crop.${ext}`, { type: finalBlob.type }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't crop that image.");
      setBusy(false);
    }
  }, [natural, frame, spec, pos, disp, file, onCropped]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={spec.title}
      style={{ position: "fixed", inset: 0, zIndex: 300, display: "grid", placeItems: "center", background: "rgba(33,29,26,.6)", padding: "var(--space-4)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={{ width: "min(480px, 96vw)", borderRadius: 20, background: "var(--card)", boxShadow: "var(--shadow-pop)", padding: "var(--space-4)" }}>
        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, marginBottom: "var(--space-3)" }}>{spec.title}</div>

        <div
          ref={frameRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: `${spec.aspect}`,
            overflow: "hidden",
            borderRadius: 14,
            background: "var(--paper-2)",
            cursor: "grab",
            touchAction: "none",
            userSelect: "none",
          }}
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL being framed
            <img
              ref={imgRef}
              src={url}
              alt=""
              draggable={false}
              onLoad={onImgLoad}
              style={{ position: "absolute", left: pos.x, top: pos.y, width: dispW || "100%", height: dispH || "auto", maxWidth: "none", pointerEvents: "none" }}
            />
          ) : null}
          {spec.round ? (
            <div
              aria-hidden
              style={{ position: "absolute", inset: 0, borderRadius: "50%", boxShadow: "0 0 0 9999px rgba(33,29,26,.45)", pointerEvents: "none" }}
            />
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: "var(--space-3)" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }} aria-hidden>−</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
            style={{ flex: 1, accentColor: "var(--crimson)" }}
          />
          <span style={{ fontSize: 14, color: "var(--muted)" }} aria-hidden>＋</span>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--muted)" }}>Drag to position · scroll or slide to zoom</p>

        {error ? <p style={{ margin: "8px 0 0", color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
          <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="pri" size="sm" onClick={() => void confirm()} disabled={busy || !natural}>
            {busy ? "Cropping…" : "Use photo"}
          </Button>
        </div>
      </div>
    </div>
  );
}
