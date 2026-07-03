/**
 * CopyLinkButton — a Reddit-style "Share" pill. Uses the native share sheet where available
 * (mobile), otherwise copies the URL to the clipboard and flashes "Copied". `path` is an app path
 * (e.g. /town-hall/darlington/best-bars); when omitted it shares the current page URL.
 */
"use client";

import { useState } from "react";
import { Icon } from "@roam/design";

export function CopyLinkButton({ path, label = "Share" }: { path?: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const share = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window === "undefined") return;
    const url = path ? `${window.location.origin}${path}` : window.location.href;
    const nav = navigator as Navigator & { share?: (d: { url: string }) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ url });
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

  return (
    <button type="button" onClick={(e) => void share(e)} aria-label="Share" style={pill}>
      <Icon name="share" size={15} />
      <span>{copied ? "Copied!" : label}</span>
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
