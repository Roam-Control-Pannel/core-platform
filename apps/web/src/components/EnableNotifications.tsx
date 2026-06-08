/**
 * EnableNotifications — the push-capture affordance (3b-push capture).
 *
 * A once-per-browser action, NOT tied to following any one venue: push_subscriptions
 * is keyed (profile_id, token), so enabling notifications registers THIS device for
 * the signed-in person. Which venues actually push them is the separate `follows`
 * edge that dispatch (a later slice) joins against. So this component takes no
 * venueId — it belongs wherever a person manages their account, surfaced here on a
 * screen for the capture proof.
 *
 * Flow: subscribeWebPush() does the browser dance (SW register + permission +
 * PushManager.subscribe), returning { platform, token } where token is the serialised
 * subscription. We hand that to social.register, which re-validates via @roam/core/push
 * and upserts the row. Any failure (unsupported browser, denied permission, missing
 * VAPID key, server reject) surfaces as a human-readable message.
 *
 * State ladder per the codebase idiom: idle -> working -> done | error. Gates on
 * useSession() (a subscription must belong to a signed-in profile). Mutation uses the
 * vanilla client .mutate() + cast, mirroring MeetupPanel.
 */
"use client";

import { useState } from "react";
import { Button, Card, Pill } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { subscribeWebPush, pushSupported } from "../lib/push";
import { AuthPanel } from "./AuthPanel";

type Status = "idle" | "working" | "done" | "error";

type RegisterResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; errors: string[] };

export function EnableNotifications() {
  const trpc = useTrpc();
  const session = useSession();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  // A subscription must belong to a signed-in profile (RLS: profile_id = auth.uid()).
  // Unlike a silent `return null`, offer the JIT auth prompt (mirrors ThreadList's
  // SignedOut): on `/` the visitor is anonymous by design, so hiding would be a dead
  // end. Signing in lands a session via SessionContext; this re-renders into the
  // enable affordance with nothing else to wire (same reasoning as ThreadList).
  if (!session) {
    return (
      <AuthPanel
        intro="Sign in to turn on notifications on this device."
        emailRedirectTo={signedOutReturnUrl()}
        onAuthed={() => {
          // The session change re-renders this component into the enable state.
        }}
      />
    );
  }

  async function enable() {
    setStatus("working");
    setMessage(null);
    try {
      const reg = await subscribeWebPush();
      const result = (await trpc.social.register.mutate({
        platform: reg.platform,
        token: reg.token,
      })) as RegisterResult;

      if (!result.ok) {
        setStatus("error");
        setMessage(result.errors[0] ?? "Could not register this device.");
        return;
      }
      setStatus("done");
      setMessage(null);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const supported = pushSupported();

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong>Notifications</strong>
          {status === "done" ? <Pill>On</Pill> : null}
        </div>
        <p style={{ margin: 0, color: "var(--ink-lo)", fontSize: 13.5 }}>
          Get a heads-up on this device when venues you follow post something new.
        </p>

        {!supported ? (
          <p style={{ margin: 0, color: "var(--ink-lo)", fontSize: 13 }}>
            This browser doesn&apos;t support web notifications.
          </p>
        ) : status === "done" ? (
          <p style={{ margin: 0, color: "var(--ink-lo)", fontSize: 13 }}>
            This device is registered. You can manage delivery per venue by following them.
          </p>
        ) : (
          <div>
            <Button
              variant="pri"
              onClick={() => void enable()}
              disabled={status === "working"}
            >
              {status === "working" ? "Enabling…" : "Enable notifications"}
            </Button>
          </div>
        )}

        {status === "error" && message ? (
          <p style={{ margin: 0, color: "var(--crimson)", fontSize: 13 }}>{message}</p>
        ) : null}
      </div>
    </Card>
  );
}


/** Return here after email confirmation (sign-up). Landing back on `/` signed in is
 *  enough — this component re-renders into the enable state on the session change.
 *  Mirrors ThreadList.signedOutReturnUrl (home rather than /threads). */
function signedOutReturnUrl(): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/`;
}
