/**
 * AuthModal — a focused overlay that hosts the AuthPanel.
 *
 * The design system has no dialog primitive (checked: no Modal/Dialog/Overlay/Sheet in
 * @roam/design), so this is a minimal, accessible web-local modal: a scrim, a centered
 * card, Escape-to-close, click-outside-to-close, body-scroll lock while open, and focus
 * moved into the dialog on open. It exists so signed-out visitors can reach sign-in from
 * the Explore header WITHOUT a sign-in form blocking the home page — auth is one click
 * away, not a wall (the app's "browse freely, auth on action" contract).
 *
 * It owns presentation only. AuthPanel still owns all auth logic; this wraps it. On a
 * successful sign-in AuthPanel fires onAuthed, which closes the modal — the session
 * change re-renders the header into its signed-in state with nothing else to wire.
 */
"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { AuthPanel } from "./AuthPanel";

export function AuthModal({
  open,
  onClose,
  emailRedirectTo,
  intro,
}: {
  open: boolean;
  onClose: () => void;
  emailRedirectTo: string;
  intro?: string;
}) {
  const t = useTranslations("chrome");
  const cardRef = useRef<HTMLDivElement>(null);

  // Escape-to-close + body-scroll lock while open. Both unwind on close/unmount.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Remember what had focus (the trigger) so we can hand it back on close — otherwise
    // focus falls to <body> and keyboard / screen-reader users lose their place.
    const prevFocus = document.activeElement as HTMLElement | null;
    // Move focus into the dialog so keyboard + screen-reader users land inside it.
    cardRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("signIn")}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "grid",
        placeItems: "start center",
        // Slim side gutter (12px) so the card breathes on a 375px phone; invisible on desktop,
        // where the card is centred at its 420px max with room to spare.
        padding: "var(--space-8) var(--space-3)",
        background: "rgba(20, 14, 16, 0.55)",
        overflowY: "auto",
      }}
    >
      {/* Stop propagation so clicks inside the card don't close the modal. */}
      <div
        ref={cardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, outline: "none", position: "relative" }}
      >
        <button
          onClick={onClose}
          aria-label={t("close")}
          style={{
            all: "unset",
            cursor: "pointer",
            position: "absolute",
            top: "var(--space-3)",
            right: "var(--space-3)",
            zIndex: 1,
            width: 40,
            height: 40,
            display: "grid",
            placeItems: "center",
            borderRadius: 10,
            color: "var(--muted)",
            lineHeight: 1,
          }}
        >
          <Icon name="close" size={18} />
        </button>
        <AuthPanel
          emailRedirectTo={emailRedirectTo}
          onAuthed={onClose}
          {...(intro !== undefined ? { intro } : {})}
        />
      </div>
    </div>
  );
}
