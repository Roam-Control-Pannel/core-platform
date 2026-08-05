/**
 * Lookup — staff search over users & venues (adminSearch.*), with an inline drill-in
 * detail (getUserDetail / getVenueDetail). Observe-only: shows who someone is, what
 * they've made, and their status. No PII beyond handle/name/bio is surfaced.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Pill, Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, Kicker, SectionLabel, timeAgo } from "./ui";

type Mode = "users" | "venues";

interface UserSummary {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  banned: boolean;
}
interface VenueSummary {
  id: string;
  name: string;
  status: string;
  locality: string | null;
  claimed: boolean;
  createdAt: string;
}

export function Lookup({ canAct = false }: { canAct?: boolean }) {
  const trpc = useTrpc();
  const [mode, setMode] = useState<Mode>("users");
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<UserSummary[] | undefined>(undefined);
  const [venues, setVenues] = useState<VenueSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const run = useCallback(() => {
    const term = q.trim();
    setError(null);
    setOpenId(null);
    if (!term) {
      setUsers(undefined);
      setVenues(undefined);
      return;
    }
    if (mode === "users") {
      setUsers(undefined);
      (trpc.adminSearch.users.query({ q: term, limit: 20 }) as Promise<UserSummary[]>)
        .then(setUsers)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Search failed."));
    } else {
      setVenues(undefined);
      (trpc.adminSearch.venues.query({ q: term, limit: 20 }) as Promise<VenueSummary[]>)
        .then(setVenues)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Search failed."));
    }
  }, [trpc, q, mode]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setUsers(undefined);
    setVenues(undefined);
    setOpenId(null);
  };

  const results = mode === "users" ? users : venues;

  return (
    <Card style={{ padding: "var(--space-5)" }}>
      <Kicker tone="crimson">Lookup</Kicker>
      <div style={{ display: "flex", gap: "var(--space-2)", margin: "var(--space-3) 0" }}>
        <ModeButton active={mode === "users"} onClick={() => switchMode("users")}>Users</ModeButton>
        <ModeButton active={mode === "venues"} onClick={() => switchMode("venues")}>Venues</ModeButton>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        style={{ display: "flex", gap: "var(--space-2)" }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={mode === "users" ? "Search handle or name…" : "Search venue name…"}
          aria-label={`Search ${mode}`}
          style={inputStyle}
        />
        <Button variant="pri" onClick={run}>Search</Button>
      </form>

      <div style={{ marginTop: "var(--space-4)" }}>
        {error ? (
          <ErrorLine message={error} />
        ) : results === undefined ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Enter a search above.</div>
        ) : results.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>No matches.</div>
        ) : mode === "users" ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {(users ?? []).map((u) => (
              <UserRow key={u.id} user={u} canAct={canAct} open={openId === u.id} onToggle={() => setOpenId(openId === u.id ? null : u.id)} />
            ))}
          </div>
        ) : (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {(venues ?? []).map((v) => (
              <VenueRow key={v.id} venue={v} canAct={canAct} open={openId === v.id} onToggle={() => setOpenId(openId === v.id ? null : v.id)} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        padding: "5px 12px",
        borderRadius: "var(--r-full)",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "var(--ui)",
        color: active ? "#fff" : "var(--ink-2)",
        background: active ? "var(--crimson)" : "var(--paper-2)",
      }}
    >
      {children}
    </button>
  );
}

function UserRow({ user, canAct, open, onToggle }: { user: UserSummary; canAct: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div style={{ borderRadius: 10, background: "var(--paper-2)", padding: "var(--space-3)" }}>
      <button type="button" onClick={onToggle} style={rowButton}>
        <span style={{ fontWeight: 600, color: "var(--ink-hi)" }}>
          {user.handle ? `@${user.handle}` : user.displayName ?? "—"}
        </span>
        {user.displayName && user.handle ? <span style={{ color: "var(--muted)", fontSize: 13 }}>{user.displayName}</span> : null}
        {user.banned ? <Pill variant="ghost-crim" size="sm">Banned</Pill> : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)" }}>joined {timeAgo(user.createdAt)}</span>
      </button>
      {open ? <UserDetail id={user.id} canAct={canAct} /> : null}
    </div>
  );
}

interface UserDetailData {
  profile: {
    id: string;
    handle: string | null;
    displayName: string | null;
    bio: string | null;
    createdAt: string;
    banned: boolean;
    invitedBy: string | null;
  };
  counts: { posts: number; follows: number; friends: number; invited: number };
  recentPosts: Array<{ id: string; body: string | null; createdAt: string }>;
}

function UserDetail({ id, canAct }: { id: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [data, setData] = useState<UserDetailData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [banned, setBanned] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminSearch.userDetail.query({ id }) as Promise<UserDetailData>)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setBanned(d.profile.banned);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load."));
    return () => {
      cancelled = true;
    };
  }, [trpc, id]);

  const toggleBan = async () => {
    if (banned === null) return;
    setBusy(true);
    const next = !banned;
    const mut = trpc.adminActions.setUserBanned as unknown as {
      mutate: (i: { userId: string; banned: boolean }) => Promise<{ ok: true }>;
    };
    try {
      await mut.mutate({ userId: id, banned: next });
      setBanned(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div style={detailWrap}><ErrorLine message={error} /></div>;
  if (!data) return <div style={{ ...detailWrap, color: "var(--muted)", fontSize: 13 }}>Loading…</div>;

  return (
    <div style={detailWrap}>
      {data.profile.bio ? <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: "var(--space-2)" }}>{data.profile.bio}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <CountChip label="Posts" value={data.counts.posts} />
        <CountChip label="Follows" value={data.counts.follows} />
        <CountChip label="Friends" value={data.counts.friends} />
        <CountChip label="Invited" value={data.counts.invited} />
      </div>
      {canAct ? (
        <div style={{ marginBottom: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Button variant={banned ? "neutral" : "pri"} size="sm" onClick={() => void toggleBan()} disabled={busy}>
            {busy ? "…" : banned ? "Un-ban user" : "Ban user"}
          </Button>
          {banned ? <span style={{ fontSize: 12, color: "var(--crimson-700)" }}>Currently banned</span> : null}
        </div>
      ) : null}
      {data.recentPosts.length > 0 ? (
        <>
          <SectionLabel>Recent posts</SectionLabel>
          <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
            {data.recentPosts.map((p) => (
              <div key={p.id} style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>
                {p.body ? (p.body.length > 120 ? `${p.body.slice(0, 120)}…` : p.body) : <em style={{ color: "var(--faint)" }}>media only</em>}{" "}
                <span style={{ color: "var(--faint)", fontFamily: "var(--mono)", fontSize: 10 }}>· {timeAgo(p.createdAt)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function VenueRow({ venue, canAct, open, onToggle }: { venue: VenueSummary; canAct: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div style={{ borderRadius: 10, background: "var(--paper-2)", padding: "var(--space-3)" }}>
      <button type="button" onClick={onToggle} style={rowButton}>
        <span style={{ fontWeight: 600, color: "var(--ink-hi)" }}>{venue.name}</span>
        <Pill variant={venue.claimed ? "ghost-crim" : "neutral"} size="sm">{venue.status}</Pill>
        {venue.locality ? <span style={{ color: "var(--muted)", fontSize: 13 }}>{venue.locality}</span> : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)" }}>{timeAgo(venue.createdAt)}</span>
      </button>
      {open ? <VenueDetail id={venue.id} canAct={canAct} /> : null}
    </div>
  );
}

interface VenueDetailData {
  venue: { id: string; name: string; status: string; locality: string | null; createdAt: string; ownerId: string | null };
  followerCount: number;
  owner: { id: string; handle: string | null; displayName: string | null } | null;
  recentClaims: Array<{ id: string; claimantId: string; status: string; createdAt: string }>;
}

function VenueDetail({ id, canAct }: { id: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [data, setData] = useState<VenueDetailData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    (trpc.adminSearch.venueDetail.query({ id }) as Promise<VenueDetailData>)
      .then((d) => {
        setData(d);
        setStatus(d.venue.status);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load."));
  }, [trpc, id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const suspended = status === "suspended";

  const toggleSuspend = async () => {
    setBusy(true);
    const mut = trpc.adminActions.setVenueSuspended as unknown as {
      mutate: (i: { venueId: string; suspended: boolean }) => Promise<{ ok: true }>;
    };
    try {
      await mut.mutate({ venueId: id, suspended: !suspended });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const actClaim = async (claimId: string, approve: boolean) => {
    setBusy(true);
    const path = approve ? trpc.adminActions.approveClaim : trpc.adminActions.rejectClaim;
    const mut = path as unknown as { mutate: (i: { claimId: string }) => Promise<{ ok: true }> };
    try {
      await mut.mutate({ claimId });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div style={detailWrap}><ErrorLine message={error} /></div>;
  if (!data) return <div style={{ ...detailWrap, color: "var(--muted)", fontSize: 13 }}>Loading…</div>;

  return (
    <div style={detailWrap}>
      <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <CountChip label="Followers" value={data.followerCount} />
        <CountChip label="Claims" value={data.recentClaims.length} />
      </div>
      <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: "var(--space-2)" }}>
        Owner:{" "}
        {data.owner ? (
          <strong style={{ color: "var(--ink-hi)" }}>{data.owner.handle ? `@${data.owner.handle}` : data.owner.displayName ?? data.owner.id}</strong>
        ) : (
          <em style={{ color: "var(--faint)" }}>unclaimed</em>
        )}
      </div>
      {canAct ? (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <Button variant={suspended ? "neutral" : "pri"} size="sm" onClick={() => void toggleSuspend()} disabled={busy}>
            {busy ? "…" : suspended ? "Restore venue" : "Suspend venue"}
          </Button>
        </div>
      ) : null}
      {data.recentClaims.length > 0 ? (
        <>
          <SectionLabel>Recent claims</SectionLabel>
          <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
            {data.recentClaims.map((c) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: 12, color: "var(--ink-2)" }}>
                <span>{c.status}</span>
                <span style={{ color: "var(--faint)", fontFamily: "var(--mono)", fontSize: 10 }}>{timeAgo(c.createdAt)}</span>
                {canAct && c.status === "pending" ? (
                  <>
                    <span style={{ flex: 1 }} />
                    <Button variant="pri" size="sm" onClick={() => void actClaim(c.id, true)} disabled={busy}>Approve</Button>
                    <Button variant="neutral" size="sm" onClick={() => void actClaim(c.id, false)} disabled={busy}>Reject</Button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, lineHeight: 1 }}>{value.toLocaleString()}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  boxSizing: "border-box",
  padding: "9px 12px",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  fontFamily: "var(--ui)",
  fontSize: 14,
  color: "var(--ink)",
  outline: "none",
};

const rowButton: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
};

const detailWrap: React.CSSProperties = {
  marginTop: "var(--space-3)",
  paddingTop: "var(--space-3)",
  borderTop: "1px solid var(--line)",
};
