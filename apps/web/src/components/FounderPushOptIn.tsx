/**
 * FounderPushOptIn — the push-enable nudge shown inside the founder confirmation (TownHall).
 *
 * WHY IT LIVES HERE: the founder banner already promises "we'll let you know as neighbours join"
 * (kept today by the in-app bell — the 0108 locality_newcomer notification). This is the one moment
 * a pioneer most wants that promise, so it's the highest-intent place to ask them to turn on browser
 * push — which is also what would later make push DELIVERY of that notification worth building
 * (today ~0% of contributors are subscribed). One-tap: subscribeWebPush() + social.register.
 *
 * Shown only when push is actually offerable: supported browser, permission not already granted, and
 * not enabled on this device before (a localStorage flag). Never nags — one shot, then it's gone.
 * A caller reaches this only after posting (a protected mutation), so there is always a session.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { subscribeWebPush, pushSupported } from "../lib/push";

const ENABLED_KEY = "roam:push-enabled";

type RegisterResult = { ok: true; subscriptionId: string } | { ok: false; errors: string[] };
type Status = "idle" | "working" | "done" | "error";

export function FounderPushOptIn() {
  const t = useTranslations("townHall");
  const trpc = useTrpc();
  const session = useSession();
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    // Offer only when push is possible AND we haven't already asked/enabled: unsupported browsers,
    // an already-granted permission, or a prior enable on this device all mean "don't nag".
    if (!session || !pushSupported()) {
      setShow(false);
      return;
    }
    let enabled = false;
    try {
      enabled = localStorage.getItem(ENABLED_KEY) === "1";
    } catch {
      /* private mode — just offer it */
    }
    const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
    setShow(!enabled && !granted);
  }, [session]);

  if (!show) return null;

  async function enable() {
    setStatus("working");
    try {
      const reg = await subscribeWebPush();
      const res = (await trpc.social.register.mutate({ platform: reg.platform, token: reg.token })) as RegisterResult;
      if (!res.ok) {
        setStatus("error");
        return;
      }
      try {
        localStorage.setItem(ENABLED_KEY, "1");
      } catch {
        /* best-effort */
      }
      setStatus("done");
    } catch {
      // Denied permission / unsupported / server reject — surface a quiet retry, never throw.
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: "var(--space-2)", fontSize: 13, fontWeight: 600, color: "var(--crimson-700)" }}>
        <Icon name="check" size={14} aria-hidden /> {t("founding.pushOn")}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: "var(--space-2)" }}>
      <button
        type="button"
        onClick={enable}
        disabled={status === "working"}
        style={{
          all: "unset",
          cursor: status === "working" ? "default" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "7px 13px",
          borderRadius: 999,
          border: "1px solid var(--crimson-700)",
          color: "var(--crimson-700)",
          fontSize: 13,
          fontWeight: 600,
          opacity: status === "working" ? 0.6 : 1,
        }}
      >
        <Icon name="bell" size={14} aria-hidden />
        {status === "working" ? t("founding.pushEnabling") : t("founding.pushEnable")}
      </button>
      {status === "error" ? (
        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{t("founding.pushError")}</span>
      ) : null}
    </span>
  );
}
