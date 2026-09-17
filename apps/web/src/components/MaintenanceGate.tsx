/**
 * MaintenanceGate — what a branded host shows when its channel is switched off (feature flag off).
 *
 * Before holistic plan Phase 1.4 the API answered a gated-off channel with the DEFAULT channel, so
 * nifood2go.roam-local.com silently turned into roam-local.com and nobody was told. Now the API
 * reports the channel as itself with `gatedOff`, the shell keeps that brand's chrome, and this
 * full-page cover explains the pause. The API alerts ops at the same time, so "off" is loud.
 *
 * Rendered once from the root layout; a no-op for the default channel and for any channel that is
 * live. Fixed overlay rather than a route swap so it covers deep links too.
 */
"use client";

import { useTranslations } from "next-intl";
import { useChannel } from "./ChannelProvider";

export function MaintenanceGate() {
  const t = useTranslations("maintenance");
  const { maintenance, channel } = useChannel();
  if (!maintenance) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--paper)",
        color: "var(--ink)",
      }}
    >
      <div style={{ maxWidth: 480, textAlign: "center", display: "grid", gap: 12 }}>
        {channel?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the channel's own logo URL
          <img src={channel.logoUrl} alt={channel.name} style={{ height: 40, width: "auto", margin: "0 auto 8px", display: "block" }} />
        ) : null}
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 26, margin: 0, letterSpacing: "-.02em" }}>
          {t("title")}
        </h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "var(--ink-2)" }}>{t("body")}</p>
        <p style={{ margin: "8px 0 0", fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>
          {t("poweredBy")}
        </p>
      </div>
    </div>
  );
}
