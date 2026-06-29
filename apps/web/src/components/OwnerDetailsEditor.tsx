/**
 * OwnerDetailsEditor — the venue owner's description + links editing surface (Slice 7).
 *
 * Mounted by VenueDetail's ClaimedDetail ONLY when the viewer owns the venue
 * (isOwner). A non-owner never sees it; the public description/links render is unchanged
 * for everyone.
 *
 * The owner twin of OwnerMediaManager, for venue-row text rather than photos:
 *   - DESCRIPTION: a free-text blurb (cleared by emptying the field).
 *   - LINKS: an ordered set of label→URL rows (Order / Book / Menu / website …). The
 *     server normalises these to the flat Record<string,string> the public render
 *     (linkEntries) reads, with an http(s)-only scheme allow-list. Clearing a row's
 *     label or URL drops it.
 *
 * One write path: venues.updateVenueDetails (protectedProcedure). The mutation builds its
 * patch from exactly { description, links }, so it is structurally impossible to touch any
 * other venue column; RLS (venues_owner_update, 0004 + explicit with-check in 0022) is the
 * row gate. On a successful save we call onSaved() — the page's own loadVenue refetch — so
 * the public render below updates from the server, the single source of truth (the same
 * reload-after-write discipline OwnerMediaManager uses for photo rows).
 *
 * Design system only: Card / Button from @roam/design, var(--*) tokens, native inputs
 * styled with tokens (the OwnerMediaManager precedent — the design system exports no form
 * control, so native + tokens is the house style). One crimson (variant="pri") CTA — Save.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

/** Mirror of the API caps (packages/api/src/venue-details.ts). Kept in lockstep; these
 *  are the friendly first line — the server re-enforces them as the real boundary. */
const LIMITS = {
  descriptionMax: 2000,
  linkLabelMax: 40,
  linkUrlMax: 2048,
  maxLinks: 12,
} as const;

/** An editable link row in local form state (stable id for React keys only). */
interface LinkDraft {
  key: string;
  label: string;
  url: string;
}

/** Loosely-typed tRPC surface (the TS2589 dodge OwnerMediaManager + VenueDetail use). */
interface UpdateVenueDetailsMutation {
  mutate: (input: {
    venueId: string;
    description: string | null;
    links: Record<string, string> | null;
  }) => Promise<{ ok: boolean }>;
}

/** Turn the venue's stored links jsonb into ordered editable drafts. Mirrors the public
 *  reader's filter (string values only), so what the owner edits is exactly what renders. */
function linksToDrafts(links: Record<string, unknown> | null): LinkDraft[] {
  if (!links || typeof links !== "object") return [];
  const drafts: LinkDraft[] = [];
  for (const [label, value] of Object.entries(links)) {
    if (typeof value === "string" && value.length > 0) {
      drafts.push({ key: crypto.randomUUID(), label, url: value });
    }
  }
  return drafts;
}

export function OwnerDetailsEditor({
  venueId,
  initialDescription,
  initialLinks,
  onSaved,
}: {
  venueId: string;
  initialDescription: string | null;
  initialLinks: Record<string, unknown> | null;
  onSaved: () => Promise<unknown> | void;
}) {
  const trpc = useTrpc();

  // Seed form state once from the venue the page already holds. After a save we call
  // onSaved (the page refetch); the page re-renders this component with fresh initial*,
  // and an explicit "Reset" rebuilds drafts from the latest props.
  const [description, setDescription] = useState<string>(initialDescription ?? "");
  const [links, setLinks] = useState<LinkDraft[]>(() => linksToDrafts(initialLinks));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  const descLen = description.trim().length;
  const descOver = descLen > LIMITS.descriptionMax;

  /** Per-row client validation messages (server is the real boundary; this is fast UX). */
  const linkIssue = useCallback((d: LinkDraft): string | null => {
    const label = d.label.trim();
    const url = d.url.trim();
    if (label.length === 0 && url.length === 0) return null; // blank row = will be dropped
    if (label.length === 0) return "Add a label.";
    if (url.length === 0) return "Add a URL.";
    if (label.length > LIMITS.linkLabelMax) return `Label too long (max ${LIMITS.linkLabelMax}).`;
    if (url.length > LIMITS.linkUrlMax) return `URL too long.`;
    try {
      const p = new URL(url);
      if (p.protocol !== "http:" && p.protocol !== "https:") return "Use an http(s) link.";
    } catch {
      return "That doesn't look like a valid URL.";
    }
    return null;
  }, []);

  const nonBlankLinks = useMemo(
    () => links.filter((d) => d.label.trim().length > 0 || d.url.trim().length > 0),
    [links],
  );
  const anyLinkInvalid = useMemo(
    () => nonBlankLinks.some((d) => linkIssue(d) !== null),
    [nonBlankLinks, linkIssue],
  );
  const tooManyLinks = nonBlankLinks.length > LIMITS.maxLinks;
  const canSave = !busy && !descOver && !anyLinkInvalid && !tooManyLinks;

  const addLink = useCallback(() => {
    setLinks((prev) =>
      prev.length >= LIMITS.maxLinks ? prev : [...prev, { key: crypto.randomUUID(), label: "", url: "" }],
    );
  }, []);

  const updateLink = useCallback((key: string, patch: Partial<Pick<LinkDraft, "label" | "url">>) => {
    setLinks((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }, []);

  const removeLink = useCallback((key: string) => {
    setLinks((prev) => prev.filter((d) => d.key !== key));
  }, []);

  const reset = useCallback(() => {
    setDescription(initialDescription ?? "");
    setLinks(linksToDrafts(initialLinks));
    setError(null);
    setSavedTick(false);
  }, [initialDescription, initialLinks]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSavedTick(false);
    try {
      // Build the links map the server expects: flat label→url, blank rows dropped,
      // trimmed. The server re-validates + re-normalises; this is the friendly mirror.
      const map: Record<string, string> = {};
      for (const d of links) {
        const label = d.label.trim();
        const url = d.url.trim();
        if (label.length > 0 && url.length > 0) map[label] = url;
      }
      const trimmedDesc = description.trim();

      const updateVenueDetails = trpc.venues
        .updateVenueDetails as unknown as UpdateVenueDetailsMutation;
      const res = await updateVenueDetails.mutate({
        venueId,
        description: trimmedDesc.length > 0 ? trimmedDesc : null,
        links: Object.keys(map).length > 0 ? map : null,
      });
      if (!res.ok) {
        // Zero rows updated => RLS refused (not owner / not claimed). Honest, not phantom.
        setError("Couldn't save your changes. Please try again.");
        return;
      }
      setSavedTick(true);
      await onSaved(); // the page's loadVenue refetch — public render reads fresh server truth
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't save your changes.");
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, description, links, onSaved]);

  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    letterSpacing: ".06em",
    textTransform: "uppercase",
    color: "var(--muted)",
    marginBottom: "var(--space-2)",
  };
  const fieldStyle: React.CSSProperties = {
    width: "100%",
    padding: "var(--space-2) var(--space-3)",
    border: "1px solid var(--line-2)",
    borderRadius: 10,
    background: "#fff",
    color: "var(--ink)",
    font: "inherit",
    boxSizing: "border-box",
  };

  return (
    <div>
      {/* Description */}
      <div style={{ marginBottom: "var(--space-5)" }}>
        <div style={labelStyle}>Description</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Tell people what makes this place worth a visit."
          style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.6 }}
          disabled={busy}
        />
        <div
          style={{
            fontSize: 12,
            color: descOver ? "var(--crimson-700)" : "var(--muted)",
            marginTop: 4,
            textAlign: "right",
          }}
        >
          {descLen}/{LIMITS.descriptionMax}
        </div>
      </div>

      {/* Links */}
      <div>
        <div style={labelStyle}>Links</div>
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {links.map((d) => {
            const issue = linkIssue(d);
            return (
              <div key={d.key} style={{ display: "grid", gap: 6 }}>
                <div
                  style={{
                    display: "flex",
                    gap: "var(--space-2)",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <input
                    value={d.label}
                    onChange={(e) => updateLink(d.key, { label: e.target.value })}
                    placeholder="Label (e.g. Menu)"
                    style={{ ...fieldStyle, flex: "1 1 140px", minWidth: 0 }}
                    disabled={busy}
                    aria-label="Link label"
                  />
                  <input
                    value={d.url}
                    onChange={(e) => updateLink(d.key, { url: e.target.value })}
                    placeholder="https://…"
                    inputMode="url"
                    style={{ ...fieldStyle, flex: "2 1 220px", minWidth: 0 }}
                    disabled={busy}
                    aria-label="Link URL"
                  />
                  <Button variant="neutral" size="sm" disabled={busy} onClick={() => removeLink(d.key)}>
                    Remove
                  </Button>
                </div>
                {issue ? (
                  <div style={{ fontSize: 12, color: "var(--crimson-700)" }}>{issue}</div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: "var(--space-3)" }}>
          <Button
            variant="neutral"
            size="sm"
            disabled={busy || links.length >= LIMITS.maxLinks}
            onClick={addLink}
          >
            + Add a link
          </Button>
          {nonBlankLinks.length >= LIMITS.maxLinks ? (
            <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: "var(--space-2)" }}>
              That&apos;s the maximum of {LIMITS.maxLinks}.
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div
          style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-4)" }}
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "center",
          marginTop: "var(--space-5)",
        }}
      >
        <Button variant="pri" disabled={!canSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save details"}
        </Button>
        <Button variant="neutral" size="sm" disabled={busy} onClick={reset}>
          Reset
        </Button>
        {savedTick && !busy ? (
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Saved.</span>
        ) : null}
      </div>
    </div>
  );
}
