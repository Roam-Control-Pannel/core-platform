/**
 * CopyLinkButton — the ONE share affordance for the app. Uses the native share sheet where
 * available (mobile → WhatsApp / LinkedIn / Instagram / Messages / anywhere), otherwise copies the
 * URL to the clipboard and flashes "Copied". This is the primitive dropped onto every shareable
 * entity (venue, profile, plan, post, topic…) so the share behaviour is identical everywhere.
 *
 * - `path` is an app path (e.g. /venue/the-dog-inn); when omitted it shares the current page URL.
 * - `title` / `text` are handed to the native sheet so the share carries context (the clipboard
 *   fallback is always URL-only, since that's all that pastes cleanly into a chat box).
 * - `variant` picks the look: "pill" (Reddit-style action-bar chip, the default) or "button"
 *   (a full design-system Button, for detail-screen action rows).
 */
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Icon, Button } from "@roam/design";

export function CopyLinkButton({
  path,
  label,
  title,
  text,
  variant = "pill",
  size = "md",
  block = false,
}: {
  path?: string;
  label?: string;
  title?: string;
  text?: string;
  variant?: "pill" | "button";
  size?: "md" | "sm";
  block?: boolean;
}) {
  const t = useTranslations("copyLinkButton");
  const [copied, setCopied] = useState(false);

  const share = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window === "undefined") return;
    const url = path ? `${window.location.origin}${path}` : window.location.href;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      const data: ShareData = { url };
      if (title) data.title = title;
      if (text) data.text = text;
      try {
        await nav.share(data);
        return;
      } catch {
        /* user cancelled or unsupported — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const shown = copied ? t("copied") : (label ?? t("share"));

  if (variant === "button") {
    return (
      <Button variant="neutral" size={size} block={block} onClick={(e) => void share(e)}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="share" size={size === "sm" ? 14 : 16} /> {shown}
        </span>
      </Button>
    );
  }

  // An empty label makes an icon-only pill (compact rows); the "Copied!" flash still shows.
  return (
    <button type="button" onClick={(e) => void share(e)} aria-label={t("share")} style={pill}>
      <Icon name="share" size={15} />
      {shown ? <span>{shown}</span> : null}
    </button>
  );
}

const pill: React.CSSProperties = {
  all: "unset",
  boxSizing: "border-box",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 12px",
  borderRadius: 999,
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  color: "var(--ink-2)",
  fontFamily: "var(--ui)",
  fontSize: 13,
  fontWeight: 600,
};
