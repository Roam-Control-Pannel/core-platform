/**
 * LinkPreviewCard — a Reddit-style link card for a Town Hall link post: a thumbnail, the domain,
 * and the link title, opening the URL in a new tab. Reused on the board, the topic page, and the
 * composer preview. When `onRemove` is set it renders as a non-link preview with a remove button
 * (composer use). The image is whatever the server unfurled (og:image), so it's a trusted value.
 */
"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";

export interface LinkPreview {
  url: string;
  domain: string | null;
  title: string | null;
  imageUrl: string | null;
}

export function LinkPreviewCard({ link, onRemove }: { link: LinkPreview; onRemove?: () => void }) {
  const t = useTranslations("linkPreviewCard");
  const inner = (
    <div style={{ display: "flex", alignItems: "stretch", border: "1px solid var(--line)", borderRadius: "var(--r-md)", overflow: "hidden", background: "var(--paper-2)" }}>
      <span aria-hidden style={{ width: 76, minWidth: 76, height: 76, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", overflow: "hidden" }}>
        {link.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external unfurled og:image
          <img src={link.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <Icon name="link" size={22} />
        )}
      </span>
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, padding: "8px 12px" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em", color: "var(--crimson-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {link.domain || t("link")}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {link.title || link.url}
        </span>
      </span>
      {!onRemove ? (
        <span aria-hidden style={{ display: "grid", placeItems: "center", padding: "0 12px", color: "var(--faint)" }}>
          <Icon name="share" size={15} />
        </span>
      ) : null}
    </div>
  );

  if (onRemove) {
    return (
      <div style={{ position: "relative" }}>
        {inner}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeLink")}
          style={{ all: "unset", cursor: "pointer", position: "absolute", top: -8, right: -8, width: 22, height: 22, borderRadius: "50%", background: "var(--ink)", color: "#fff", display: "grid", placeItems: "center" }}
        >
          <Icon name="close" size={13} />
        </button>
      </div>
    );
  }

  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer nofollow" style={{ display: "block", textDecoration: "none", color: "inherit" }} onClick={(e) => e.stopPropagation()}>
      {inner}
    </a>
  );
}
