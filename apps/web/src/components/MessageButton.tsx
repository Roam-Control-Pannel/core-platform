/**
 * MessageButton — "Message" affordance that opens (get-or-creates) the 1:1 direct chat with
 * another profile and routes to it. The direct-chat entry point of the chat/plans split: it
 * lives anywhere you see another person (a friends row, their wall) and lands you in /threads/[id].
 *
 * Dedupe is server-side (chat.directThread → get_or_create_direct_thread), so tapping it twice
 * always returns the same DM. Renders nothing when signed out or pointed at your own id.
 */
"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

export function MessageButton({
  profileId,
  size = "sm",
  variant = "neutral",
  label,
}: {
  profileId: string;
  size?: "sm" | "md";
  variant?: "pri" | "neutral" | "ghost";
  label?: string;
}) {
  const t = useTranslations("messageButton");
  const trpc = useTrpc();
  const session = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const open = useCallback(async () => {
    setBusy(true);
    const m = trpc.chat.directThread as unknown as {
      mutate: (i: { profileId: string }) => Promise<{ threadId: string }>;
    };
    try {
      const { threadId } = await m.mutate({ profileId });
      router.push(`/threads/${threadId}`);
    } catch {
      setBusy(false);
    }
  }, [trpc, profileId, router]);

  // Hidden when signed out or pointed at yourself (no self-DM).
  if (!session || session.user?.id === profileId) return null;

  return (
    <Button variant={variant} size={size} onClick={() => void open()} disabled={busy}>
      {busy ? t("opening") : label ?? t("message")}
    </Button>
  );
}
