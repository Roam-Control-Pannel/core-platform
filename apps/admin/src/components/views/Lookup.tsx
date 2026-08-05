/**
 * Lookup — staff search over users & venues with inline drill-in detail and actions.
 * Acting roles get Ban/Un-ban (users) and Suspend/Restore + per-claim Approve/Reject
 * (venues); each action pings onChanged so the sidebar badge stays live. No PII beyond
 * handle/name/bio is surfaced.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "../TrpcProvider";
import { C, F } from "../../theme";
import { ErrorLine, Kicker, Label, Panel, timeAgo } from "../ui";

type Mode = "users" | "venues";

interface UserSummary { id: string; handle: string | null; displayName: string | null; createdAt: string; banned: boolean }
interface VenueSummary { id: string; name: string; status: string; locality: string | null; claimed: boolean; createdAt: string }

export function LookupView({ canAct, onChanged }: { canAct: boolean; onChanged: () => void }) {
  const trpc = useTrpc();
  const [mode, setMode] = useState<Mode>("users");
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<UserSummary[] | undefined>(undefined);
  const [venues, setVenues] = useState<VenueSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const run = useCallback(() => {
    const term = q.trim();
    setError(null); setOpenId(null);
    if (!term) { setUsers(undefined); setVenues(undefined); return; }
    if (mode === "users") {
      setUsers(undefined);
      (trpc.adminSearch.users.query({ q: term, limit: 25 }) as Promise<UserSummary[]>).then(setUsers).catch((e: unknown) => setError(e instanceof Error ? e.message : "Search failed."));
    } else {
      setVenues(undefined);
      (trpc.adminSearch.venues.query({ q: term, limit: 25 }) as Promise<VenueSummary[]>).then(setVenues).catch((e: unknown) => setError(e instanceof Error ? e.message : "Search failed."));
    }
  }, [trpc, q, mode]);

  const switchMode = (m: Mode) => { setMode(m); setUsers(undefined); setVenues(undefined); setOpenId(null); };
  const results = mode === "users" ? users : venues;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <header>
        <Kicker>Roam · Internal</Kicker>
        <h1 style={{ fontFamily: F.display, fontWeight: 700, fontSize: 40, letterSpacing: "-.03em", margin: "2px 0 0" }}>Lookup</h1>
      </header>

      <Panel style={{ padding: 24 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <Toggle active={mode === "users"} onClick={() => switchMode("users")}>Users</Toggle>
          <Toggle active={mode === "venues"} onClick={() => switchMode("venues")}>Venues</Toggle>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); run(); }} style={{ display: "flex", gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={mode === "users" ? "Search handle or name…" : "Search venue name…"} aria-label={`Search ${mode}`} style={inputStyle} />
          <button type="submit" style={searchBtn}>Search</button>
        </form>

        <div style={{ marginTop: 18 }}>
          {error ? <ErrorLine message={error} /> : results === undefined ? (
            <div style={{ color: C.muted, fontSize: 13 }}>Enter a search above.</div>
          ) : results.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 13 }}>No matches.</div>
          ) : mode === "users" ? (
            <div style={{ display: "grid" }}>
              {(users ?? []).map((u, i) => <UserRow key={u.id} user={u} canAct={canAct} onChanged={onChanged} open={openId === u.id} first={i === 0} onToggle={() => setOpenId(openId === u.id ? null : u.id)} />)}
            </div>
          ) : (
            <div style={{ display: "grid" }}>
              {(venues ?? []).map((v, i) => <VenueRow key={v.id} venue={v} canAct={canAct} onChanged={onChanged} open={openId === v.id} first={i === 0} onToggle={() => setOpenId(openId === v.id ? null : v.id)} />)}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ all: "unset", cursor: "pointer", padding: "6px 14px", borderRadius: 4, fontFamily: F.ui, fontSize: 13, fontWeight: 700, color: active ? "#fff" : C.inkSoft, background: active ? C.ink : "transparent", border: `1px solid ${active ? C.ink : C.line}` }}>
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- user row */

function UserRow({ user, canAct, onChanged, open, first, onToggle }: { user: UserSummary; canAct: boolean; onChanged: () => void; open: boolean; first: boolean; onToggle: () => void }) {
  return (
    <div style={{ borderTop: first ? "none" : `1px solid ${C.line}` }}>
      <button type="button" onClick={onToggle} style={rowBtn}>
        <strong style={{ color: C.ink }}>{user.handle ? `@${user.handle}` : user.displayName ?? "—"}</strong>
        {user.displayName && user.handle ? <span style={{ color: C.muted, fontSize: 13 }}>{user.displayName}</span> : null}
        {user.banned ? <Tag>Banned</Tag> : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: F.mono, fontSize: 11, color: C.faint }}>joined {timeAgo(user.createdAt)}</span>
      </button>
      {open ? <UserDetail id={user.id} canAct={canAct} onChanged={onChanged} /> : null}
    </div>
  );
}

interface UserDetailData {
  profile: { id: string; handle: string | null; displayName: string | null; bio: string | null; createdAt: string; banned: boolean; invitedBy: string | null };
  counts: { posts: number; follows: number; friends: number; invited: number };
  recentPosts: Array<{ id: string; body: string | null; createdAt: string }>;
}

function UserDetail({ id, canAct, onChanged }: { id: string; canAct: boolean; onChanged: () => void }) {
  const trpc = useTrpc();
  const [data, setData] = useState<UserDetailData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [banned, setBanned] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminSearch.userDetail.query({ id }) as Promise<UserDetailData>)
      .then((d) => { if (cancelled) return; setData(d); setBanned(d.profile.banned); })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load."));
    return () => { cancelled = true; };
  }, [trpc, id]);

  const toggleBan = async () => {
    if (banned === null) return;
    setBusy(true);
    const next = !banned;
    const mut = trpc.adminActions.setUserBanned as unknown as { mutate: (i: { userId: string; banned: boolean }) => Promise<{ ok: true }> };
    try { await mut.mutate({ userId: id, banned: next }); setBanned(next); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusy(false); }
  };

  if (error) return <div style={detailWrap}><ErrorLine message={error} /></div>;
  if (!data) return <div style={{ ...detailWrap, color: C.muted, fontSize: 13 }}>Loading…</div>;

  return (
    <div style={detailWrap}>
      {data.profile.bio ? <div style={{ fontSize: 13.5, color: C.inkSoft, marginBottom: 12 }}>{data.profile.bio}</div> : null}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 14 }}>
        <Count label="Posts" value={data.counts.posts} />
        <Count label="Follows" value={data.counts.follows} />
        <Count label="Friends" value={data.counts.friends} />
        <Count label="Invited" value={data.counts.invited} />
      </div>
      {canAct ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <button type="button" onClick={() => void toggleBan()} disabled={busy} style={banned ? ghostBtn : dangerBtn}>{busy ? "…" : banned ? "Un-ban user" : "Ban user"}</button>
          {banned ? <span style={{ fontSize: 12, color: C.redInk }}>Currently banned</span> : null}
        </div>
      ) : null}
      {data.recentPosts.length > 0 ? (
        <>
          <Label>Recent posts</Label>
          <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
            {data.recentPosts.map((p) => (
              <div key={p.id} style={{ fontSize: 12.5, color: C.inkSoft, lineHeight: 1.4 }}>
                {p.body ? (p.body.length > 120 ? `${p.body.slice(0, 120)}…` : p.body) : <em style={{ color: C.faint }}>media only</em>}{" "}
                <span style={{ color: C.faint, fontFamily: F.mono, fontSize: 10 }}>· {timeAgo(p.createdAt)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- venue row */

function VenueRow({ venue, canAct, onChanged, open, first, onToggle }: { venue: VenueSummary; canAct: boolean; onChanged: () => void; open: boolean; first: boolean; onToggle: () => void }) {
  return (
    <div style={{ borderTop: first ? "none" : `1px solid ${C.line}` }}>
      <button type="button" onClick={onToggle} style={rowBtn}>
        <strong style={{ color: C.ink }}>{venue.name}</strong>
        <Tag tone={venue.status === "suspended" ? "red" : "ink"}>{venue.status}</Tag>
        {venue.locality ? <span style={{ color: C.muted, fontSize: 13 }}>{venue.locality}</span> : null}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: F.mono, fontSize: 11, color: C.faint }}>{timeAgo(venue.createdAt)}</span>
      </button>
      {open ? <VenueDetail id={venue.id} canAct={canAct} onChanged={onChanged} /> : null}
    </div>
  );
}

interface VenueDetailData {
  venue: { id: string; name: string; status: string; locality: string | null; createdAt: string; ownerId: string | null };
  followerCount: number;
  owner: { id: string; handle: string | null; displayName: string | null } | null;
  recentClaims: Array<{ id: string; claimantId: string; status: string; createdAt: string }>;
}

function VenueDetail({ id, canAct, onChanged }: { id: string; canAct: boolean; onChanged: () => void }) {
  const trpc = useTrpc();
  const [data, setData] = useState<VenueDetailData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    (trpc.adminSearch.venueDetail.query({ id }) as Promise<VenueDetailData>)
      .then((d) => { setData(d); setStatus(d.venue.status); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load."));
  }, [trpc, id]);
  useEffect(() => { reload(); }, [reload]);

  const suspended = status === "suspended";
  const toggleSuspend = async () => {
    setBusy(true);
    const mut = trpc.adminActions.setVenueSuspended as unknown as { mutate: (i: { venueId: string; suspended: boolean }) => Promise<{ ok: true }> };
    try { await mut.mutate({ venueId: id, suspended: !suspended }); reload(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusy(false); }
  };
  const actClaim = async (claimId: string, approve: boolean) => {
    setBusy(true);
    const path = approve ? trpc.adminActions.approveClaim : trpc.adminActions.rejectClaim;
    const mut = path as unknown as { mutate: (i: { claimId: string }) => Promise<{ ok: true }> };
    try { await mut.mutate({ claimId }); reload(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setBusy(false); }
  };

  if (error) return <div style={detailWrap}><ErrorLine message={error} /></div>;
  if (!data) return <div style={{ ...detailWrap, color: C.muted, fontSize: 13 }}>Loading…</div>;

  return (
    <div style={detailWrap}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }}>
        <Count label="Followers" value={data.followerCount} />
        <Count label="Claims" value={data.recentClaims.length} />
      </div>
      <div style={{ fontSize: 13.5, color: C.inkSoft, marginBottom: 12 }}>
        Owner:{" "}
        {data.owner ? <strong style={{ color: C.ink }}>{data.owner.handle ? `@${data.owner.handle}` : data.owner.displayName ?? data.owner.id}</strong> : <em style={{ color: C.faint }}>unclaimed</em>}
      </div>
      {canAct ? (
        <div style={{ marginBottom: 12 }}>
          <button type="button" onClick={() => void toggleSuspend()} disabled={busy} style={suspended ? ghostBtn : dangerBtn}>{busy ? "…" : suspended ? "Restore venue" : "Suspend venue"}</button>
        </div>
      ) : null}
      {data.recentClaims.length > 0 ? (
        <>
          <Label>Recent claims</Label>
          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            {data.recentClaims.map((c) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: C.inkSoft }}>
                <span>{c.status}</span>
                <span style={{ color: C.faint, fontFamily: F.mono, fontSize: 10 }}>{timeAgo(c.createdAt)}</span>
                {canAct && c.status === "pending" ? (
                  <>
                    <span style={{ flex: 1 }} />
                    <button type="button" onClick={() => void actClaim(c.id, true)} disabled={busy} style={smallDanger}>Approve</button>
                    <button type="button" onClick={() => void actClaim(c.id, false)} disabled={busy} style={smallGhost}>Reject</button>
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

/* ------------------------------------------------------------------------ atoms */

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, lineHeight: 1 }}>{value.toLocaleString()}</div>
      <div style={{ fontFamily: F.mono, fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: C.muted, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Tag({ children, tone = "ink" }: { children: React.ReactNode; tone?: "ink" | "red" }) {
  return (
    <span style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: "#fff", background: tone === "red" ? C.red : C.ink, borderRadius: 3, padding: "2px 7px" }}>
      {children}
    </span>
  );
}

const rowBtn: React.CSSProperties = { all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "13px 0" };
const detailWrap: React.CSSProperties = { padding: "6px 0 16px", borderTop: `1px dashed ${C.line}`, marginTop: 2 };
const inputStyle: React.CSSProperties = { flex: 1, boxSizing: "border-box", padding: "10px 13px", background: "#fff", border: `1px solid ${C.lineStrong}`, borderRadius: 4, fontFamily: F.ui, fontSize: 14, color: C.ink, outline: "none" };
const searchBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "10px 18px", background: C.ink, color: "#fff", borderRadius: 4, fontFamily: F.ui, fontSize: 14, fontWeight: 700, textAlign: "center" };
const ghostBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "7px 14px", border: `1px solid ${C.lineStrong}`, borderRadius: 4, fontFamily: F.ui, fontSize: 13, fontWeight: 600, color: C.ink };
const dangerBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "7px 14px", background: C.red, color: "#fff", borderRadius: 4, fontFamily: F.ui, fontSize: 13, fontWeight: 700 };
const smallGhost: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "4px 10px", border: `1px solid ${C.lineStrong}`, borderRadius: 3, fontFamily: F.ui, fontSize: 12, fontWeight: 600, color: C.ink };
const smallDanger: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "4px 10px", background: C.red, color: "#fff", borderRadius: 3, fontFamily: F.ui, fontSize: 12, fontWeight: 700 };
