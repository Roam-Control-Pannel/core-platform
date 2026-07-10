/**
 * FriendsList — the /friends surface: incoming friend requests (accept / decline) and your
 * friends (each linking to their wall). Private (protected); signed out shows the sign-in nudge.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { MessageButton } from "./MessageButton";
import { AddFriendButton } from "./AddFriendButton";
import { UserSearch } from "./UserSearch";
import rowStyles from "./listRow.module.css";

interface Person {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function name(t: ReturnType<typeof useTranslations>, p: Person): string {
  if (p.displayName && p.displayName.trim()) return p.displayName.trim();
  if (p.handle && p.handle.trim()) return `@${p.handle.trim()}`;
  return t("fallbackName");
}

function Avatar({ p, size }: { p: Person; size: number }) {
  const t = useTranslations("friendsList");
  if (p.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={p.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {name(t, p).replace(/^@/, "").charAt(0).toUpperCase() || "·"}
    </span>
  );
}

export function FriendsList() {
  const t = useTranslations("friendsList");
  const trpc = useTrpc();
  const session = useSession();
  const hasSession = !!session;
  const [requests, setRequests] = useState<Person[] | undefined>(undefined);
  const [friends, setFriends] = useState<Person[] | undefined>(undefined);

  const load = useCallback(async () => {
    const reqQ = trpc.social.friendRequests as unknown as { query: () => Promise<{ ok: boolean; requests?: Person[] }> };
    const friQ = trpc.social.myFriends as unknown as { query: () => Promise<{ ok: boolean; friends?: Person[] }> };
    const [r, f] = await Promise.all([reqQ.query(), friQ.query()]);
    return { requests: r.ok ? r.requests ?? [] : [], friends: f.ok ? f.friends ?? [] : [] };
  }, [trpc]);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    load()
      .then(({ requests: r, friends: f }) => {
        if (cancelled) return;
        setRequests(r);
        setFriends(f);
      })
      .catch(() => {
        if (!cancelled) {
          setRequests([]);
          setFriends([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasSession, load]);

  const respond = useCallback(
    async (requesterId: string, accept: boolean) => {
      const m = trpc.social.respondToFriend as unknown as { mutate: (i: { requesterId: string; accept: boolean }) => Promise<{ ok: boolean }> };
      try {
        await m.mutate({ requesterId, accept });
        const { requests: r, friends: f } = await load();
        setRequests(r);
        setFriends(f);
      } catch {
        /* no-op */
      }
    },
    [trpc, load],
  );

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}>
        <span aria-hidden>←</span> {t("home")}
      </Link>
      <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: "0 0 var(--space-4)" }}>
        {t("title")}
      </h1>

      {!hasSession ? (
        <Card style={{ padding: "var(--space-4)" }}>
          <AuthPanel intro={t("signedOutIntro")} emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""} onAuthed={() => {}} />
        </Card>
      ) : (
        <>
          {/* Find people — search by name / @handle, then connect or message. */}
          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
              {t("findPeople")}
            </div>
            <UserSearch
              placeholder={t("searchPlaceholder")}
              linkToProfile
              trailing={(p) => (
                <span style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
                  <MessageButton profileId={p.id} />
                  <AddFriendButton userId={p.id} />
                </span>
              )}
            />
          </Card>

          {/* Incoming requests */}
          {requests && requests.length > 0 ? (
            <section style={{ marginBottom: "var(--space-5)" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
                {t("requests")}
              </div>
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {requests.map((p) => (
                  <Card key={p.id} style={{ padding: "var(--space-3) var(--space-4)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                      <Link href={`/u/${p.handle ?? p.id}`} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}>
                        <Avatar p={p} size={36} />
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name(t, p)}</span>
                      </Link>
                      <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
                        <Button variant="pri" size="sm" onClick={() => void respond(p.id, true)}>{t("accept")}</Button>
                        <Button variant="neutral" size="sm" onClick={() => void respond(p.id, false)}>{t("decline")}</Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          {/* Friends */}
          {friends === undefined ? (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <div style={{ height: 56, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
              <div style={{ height: 56, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
            </div>
          ) : friends.length === 0 && (!requests || requests.length === 0) ? (
            <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
              <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
                {t.rich("empty", { strong: (chunks) => <strong>{chunks}</strong> })}
              </p>
            </Card>
          ) : friends.length > 0 ? (
            <section>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
                {t("friendCount", { count: friends.length })}
              </div>
              <div style={{ display: "grid", gap: "var(--space-1)" }}>
                {friends.map((p) => (
                  <div key={p.id} className={rowStyles.row} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "8px 8px", borderRadius: "var(--r-md)" }}>
                    <Link href={`/u/${p.handle ?? p.id}`} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}>
                      <Avatar p={p} size={32} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name(t, p)}</span>
                    </Link>
                    <MessageButton profileId={p.id} />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
