/**
 * ActiveFriends — a horizontal strip of friends who are currently broadcasting an availability
 * (presence.friendsAvailability): "free to meet", "out & about" or "heads down". A compact,
 * Facebook/Messenger-style "active now" row at the top of Home. Signed-in only; renders nothing
 * when no friend is live, so it never shows an empty shell. Each avatar links to that friend's
 * profile, with a status-coloured dot.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

/** Status-dot colours, matched to PresenceStatus. */
const DOT: Record<string, string> = {
  free_to_meet: "var(--positive, #1f9d55)",
  out_and_about: "var(--crimson-600, #d1466b)",
  heads_down: "var(--muted)",
};

interface ActiveFriend {
  profile_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  availability: string;
  note: string | null;
}

export function ActiveFriends() {
  const t = useTranslations("home");
  const trpc = useTrpc();
  const session = useSession();
  const [friends, setFriends] = useState<ActiveFriend[] | undefined>(undefined);

  useEffect(() => {
    if (!session) {
      setFriends(undefined);
      return;
    }
    let cancelled = false;
    const q = trpc.presence.friendsAvailability as unknown as { query: () => Promise<ActiveFriend[]> };
    q.query()
      .then((rows) => { if (!cancelled) setFriends(rows ?? []); })
      .catch(() => { if (!cancelled) setFriends([]); });
    return () => { cancelled = true; };
  }, [trpc, session]);

  if (!session || !friends || friends.length === 0) return null;

  return (
    <Card style={{ padding: "var(--space-3) var(--space-4)", marginBottom: "var(--space-4)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
        {t("activeFriends.title")}
      </div>
      <div style={{ display: "flex", gap: "var(--space-3)", overflowX: "auto", paddingBottom: 2 }}>
        {friends.map((f) => {
          const name = (f.display_name ?? "").trim().split(/\s+/)[0] || (f.handle ? `@${f.handle}` : "");
          return (
            <Link
              key={f.profile_id}
              href={`/u/${f.handle ?? f.profile_id}`}
              title={f.note ?? undefined}
              style={{ flexShrink: 0, width: 64, textDecoration: "none", textAlign: "center" }}
            >
              <div style={{ position: "relative", width: 52, height: 52, margin: "0 auto" }}>
                {f.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- small avatar in the presence strip
                  <img src={f.avatar_url} alt="" style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", display: "block" }} />
                ) : (
                  <span aria-hidden style={{ display: "grid", placeItems: "center", width: 52, height: 52, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)" }}>
                    <Icon name="person" size={22} />
                  </span>
                )}
                <span
                  aria-hidden
                  style={{ position: "absolute", right: 2, bottom: 2, width: 13, height: 13, borderRadius: "50%", background: DOT[f.availability] ?? "var(--muted)", border: "2px solid var(--card, #fff)" }}
                />
              </div>
              <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
