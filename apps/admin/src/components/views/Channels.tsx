/**
 * Channels — Roam HQ's marketplace-channel console (F2G B4a). Three tabs:
 *   Config     — edit a channel's theme / logo / surface / sections / nav + its domain map, and the
 *                open↔members membership flip (behind a confirm; it hides non-member venues).
 *   Roster     — browse the channel's channel_members (status / council / name search, paged).
 *   Review     — the B4b match-review queue: unbound members + ranked candidates → confirm / dismiss.
 *   Onboarding — the funnel (counts by status) and a by-council breakdown.
 *
 * Reads via channelsAdmin.*, writes via adminActions.* (each audited server-side). Acting roles get
 * the editors; viewers see everything read-only. Matches the Lookup/Moderation view conventions.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "../TrpcProvider";
import { C, F } from "../../theme";
import { ErrorLine, Kicker, Label, Panel } from "../ui";

type Tab = "config" | "roster" | "review" | "onboarding" | "import";

interface NavItem { key: string; href: string; labelKey: string }
interface ChannelInfo {
  id: string; key: string; name: string; tagline: string | null; isDefault: boolean;
  theme: { brand?: string; accent?: string; paper?: string; ink?: string };
  logoUrl: string | null; membershipMode: "open" | "members";
  nav: NavItem[]; sections: Record<string, boolean>; surface: "roam" | "storefront";
}

const KNOWN_SECTIONS = ["storefront", "directory", "suppliers", "jobs", "explore", "townHall", "market", "deals", "events"];
const MEMBER_STATUSES = ["imported", "invited", "claimed", "live", "lapsed", "removed"] as const;

export function ChannelsView({ canAct }: { canAct: boolean }) {
  const trpc = useTrpc();
  const [channels, setChannels] = useState<ChannelInfo[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("config");

  useEffect(() => {
    let cancelled = false;
    (trpc.channelsAdmin.list.query() as Promise<ChannelInfo[]>)
      .then((cs) => {
        if (cancelled) return;
        setChannels(cs);
        // Prefer a branded (non-default) channel; else the first.
        setSelectedKey(cs.find((c) => !c.isDefault)?.key ?? cs[0]?.key ?? null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load channels."));
    return () => { cancelled = true; };
  }, [trpc]);

  const selected = channels?.find((c) => c.key === selectedKey) ?? null;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <header>
        <Kicker>Roam · Internal</Kicker>
        <h1 style={{ fontFamily: F.display, fontWeight: 700, fontSize: 40, letterSpacing: "-.03em", margin: "2px 0 0" }}>Channels</h1>
      </header>

      {error ? <ErrorLine message={error} /> : null}

      <Panel style={{ padding: 24 }}>
        {/* Channel picker + tab switch */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
          <select
            value={selectedKey ?? ""}
            onChange={(e) => setSelectedKey(e.target.value)}
            aria-label="Channel"
            style={selectStyle}
          >
            {(channels ?? []).map((c) => (
              <option key={c.key} value={c.key}>{c.name} ({c.key}){c.isDefault ? " · default" : ""}</option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          {(["config", "roster", "review", "onboarding", "import"] as Tab[]).map((t) => (
            <Toggle key={t} active={tab === t} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</Toggle>
          ))}
        </div>

        {channels === undefined ? (
          <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : !selected ? (
          <div style={{ color: C.muted, fontSize: 13 }}>No channels.</div>
        ) : tab === "config" ? (
          <ConfigTab channel={selected} canAct={canAct} onSaved={(k) => reload(trpc, setChannels, k, setSelectedKey)} />
        ) : tab === "roster" ? (
          <RosterTab channelKey={selected.key} canAct={canAct} />
        ) : tab === "review" ? (
          <ReviewTab channelKey={selected.key} canAct={canAct} />
        ) : tab === "onboarding" ? (
          <OnboardingTab channelKey={selected.key} />
        ) : (
          <ImportTab channelKey={selected.key} canAct={canAct} />
        )}
      </Panel>
    </div>
  );
}

function reload(
  trpc: ReturnType<typeof useTrpc>,
  setChannels: (c: ChannelInfo[]) => void,
  keepKey: string,
  setSelectedKey: (k: string) => void,
) {
  (trpc.channelsAdmin.list.query() as Promise<ChannelInfo[]>).then((cs) => {
    setChannels(cs);
    setSelectedKey(keepKey);
  }).catch(() => {});
}

/* ------------------------------------------------------------------------- config */

function ConfigTab({ channel, canAct, onSaved }: { channel: ChannelInfo; canAct: boolean; onSaved: (key: string) => void }) {
  const trpc = useTrpc();
  const [surface, setSurface] = useState(channel.surface);
  const [logoUrl, setLogoUrl] = useState(channel.logoUrl ?? "");
  const [theme, setTheme] = useState({ brand: channel.theme.brand ?? "", accent: channel.theme.accent ?? "", paper: channel.theme.paper ?? "", ink: channel.theme.ink ?? "" });
  const [sections, setSections] = useState<Record<string, boolean>>(() => {
    const base: Record<string, boolean> = {};
    for (const k of KNOWN_SECTIONS) base[k] = channel.sections[k] === true;
    return base;
  });
  const [nav, setNav] = useState<NavItem[]>(channel.nav);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const call = (patch: Record<string, unknown>) => {
    const mut = trpc.adminActions.setChannelConfig as unknown as { mutate: (i: { channelKey: string; patch: Record<string, unknown> }) => Promise<{ ok: true }> };
    return mut.mutate({ channelKey: channel.key, patch });
  };

  const saveConfig = async () => {
    setBusy(true); setErr(null); setNote(null);
    const themeOut: Record<string, string> = {};
    for (const k of ["brand", "accent", "paper", "ink"] as const) if (theme[k].trim()) themeOut[k] = theme[k].trim();
    try {
      await call({ surface, logoUrl: logoUrl.trim() || null, theme: themeOut, sections, nav });
      setNote("Saved."); onSaved(channel.key);
    } catch (e) { setErr(e instanceof Error ? e.message : "Save failed."); }
    finally { setBusy(false); }
  };

  // The sensitive flip — its own control, behind a confirm, saved immediately.
  const flipMode = async () => {
    const next = channel.membershipMode === "members" ? "open" : "members";
    const msg = next === "members"
      ? "Switch to MEMBERS mode? The storefront will show ONLY tagged member venues — non-member chains (Greggs, KFC, …) disappear, and any roster coverage gaps become visible."
      : "Switch to OPEN mode? The storefront will show every eligible venue near the point (members just badged).";
    if (typeof window !== "undefined" && !window.confirm(msg)) return;
    setBusy(true); setErr(null); setNote(null);
    try { await call({ membershipMode: next }); setNote(`Mode set to ${next}.`); onSaved(channel.key); }
    catch (e) { setErr(e instanceof Error ? e.message : "Flip failed."); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {!canAct ? <div style={{ fontSize: 12.5, color: C.muted }}>View-only — ask an owner for acting access to edit.</div> : null}

      {/* Membership mode */}
      <Field label="Membership mode">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Tag tone={channel.membershipMode === "members" ? "red" : "ink"}>{channel.membershipMode}</Tag>
          {canAct ? (
            <button type="button" onClick={() => void flipMode()} disabled={busy} style={ghostBtn}>
              Switch to {channel.membershipMode === "members" ? "open" : "members"}…
            </button>
          ) : null}
        </div>
      </Field>

      {/* Surface */}
      <Field label="Surface (shell chrome)">
        <div style={{ display: "flex", gap: 8 }}>
          {(["roam", "storefront"] as const).map((s) => (
            <Toggle key={s} active={surface === s} onClick={() => canAct && setSurface(s)}>{s}</Toggle>
          ))}
        </div>
      </Field>

      {/* Sections allow-map */}
      <Field label="Sections (exposed surfaces)">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {KNOWN_SECTIONS.map((k) => (
            <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.inkSoft }}>
              <input type="checkbox" checked={sections[k] ?? false} disabled={!canAct} onChange={(e) => setSections((s) => ({ ...s, [k]: e.target.checked }))} />
              {k}
            </label>
          ))}
        </div>
      </Field>

      {/* Theme */}
      <Field label="Theme (hex)">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(["brand", "accent", "paper", "ink"] as const).map((k) => (
            <div key={k} style={{ display: "grid", gap: 4 }}>
              <span style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", color: C.muted }}>{k}</span>
              <input value={theme[k]} disabled={!canAct} onChange={(e) => setTheme((t) => ({ ...t, [k]: e.target.value }))} placeholder="#RRGGBB" style={{ ...inputStyle, width: 110 }} />
            </div>
          ))}
        </div>
      </Field>

      {/* Logo */}
      <Field label="Logo URL">
        <input value={logoUrl} disabled={!canAct} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…" style={inputStyle} />
      </Field>

      {/* Nav editor */}
      <Field label="Header nav">
        <NavEditor nav={nav} canAct={canAct} onChange={setNav} />
      </Field>

      {canAct ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="button" onClick={() => void saveConfig()} disabled={busy} style={primaryBtn}>{busy ? "…" : "Save config"}</button>
          {note ? <span style={{ fontSize: 12.5, color: "#1F6B41" }}>{note}</span> : null}
        </div>
      ) : null}
      {err ? <ErrorLine message={err} /> : null}

      <DomainsEditor channelKey={channel.key} canAct={canAct} />
    </div>
  );
}

function NavEditor({ nav, canAct, onChange }: { nav: NavItem[]; canAct: boolean; onChange: (n: NavItem[]) => void }) {
  const set = (i: number, field: keyof NavItem, val: string) => onChange(nav.map((it, j) => (j === i ? { ...it, [field]: val } : it)));
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {nav.length === 0 ? <div style={{ fontSize: 12.5, color: C.muted }}>No nav items (uses the surface default).</div> : null}
      {nav.map((it, i) => (
        <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input value={it.key} disabled={!canAct} onChange={(e) => set(i, "key", e.target.value)} placeholder="key" style={{ ...inputStyle, width: 120 }} />
          <input value={it.href} disabled={!canAct} onChange={(e) => set(i, "href", e.target.value)} placeholder="/href" style={{ ...inputStyle, width: 160 }} />
          <input value={it.labelKey} disabled={!canAct} onChange={(e) => set(i, "labelKey", e.target.value)} placeholder="labelKey" style={{ ...inputStyle, width: 160 }} />
          {canAct ? <button type="button" onClick={() => onChange(nav.filter((_, j) => j !== i))} style={smallGhost}>Remove</button> : null}
        </div>
      ))}
      {canAct ? <button type="button" onClick={() => onChange([...nav, { key: "", href: "", labelKey: "" }])} style={smallGhost}>+ Add nav item</button> : null}
    </div>
  );
}

function DomainsEditor({ channelKey, canAct }: { channelKey: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [domains, setDomains] = useState<{ host: string; channelKey: string }[] | undefined>(undefined);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    (trpc.channelsAdmin.domains.query({ channelKey }) as Promise<{ host: string; channelKey: string }[]>)
      .then(setDomains).catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load domains."));
  }, [trpc, channelKey]);
  useEffect(() => { setDomains(undefined); load(); }, [load]);

  const add = async () => {
    if (!host.trim()) return;
    setBusy(true); setErr(null);
    const mut = trpc.adminActions.addChannelDomain as unknown as { mutate: (i: { channelKey: string; host: string }) => Promise<{ ok: true }> };
    try { await mut.mutate({ channelKey, host: host.trim() }); setHost(""); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Add failed."); }
    finally { setBusy(false); }
  };
  const remove = async (h: string) => {
    setBusy(true); setErr(null);
    const mut = trpc.adminActions.removeChannelDomain as unknown as { mutate: (i: { channelKey: string; host: string }) => Promise<{ ok: true }> };
    try { await mut.mutate({ channelKey, host: h }); load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Remove failed."); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
      <Label>Domains</Label>
      <div style={{ display: "grid", gap: 6, margin: "8px 0 12px" }}>
        {domains === undefined ? <div style={{ fontSize: 12.5, color: C.muted }}>Loading…</div>
          : domains.length === 0 ? <div style={{ fontSize: 12.5, color: C.muted }}>No domains mapped.</div>
          : domains.map((d) => (
            <div key={d.host} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <span style={{ fontFamily: F.mono }}>{d.host}</span>
              <span style={{ flex: 1 }} />
              {canAct ? <button type="button" onClick={() => void remove(d.host)} disabled={busy} style={smallGhost}>Remove</button> : null}
            </div>
          ))}
      </div>
      {canAct ? (
        <form onSubmit={(e) => { e.preventDefault(); void add(); }} style={{ display: "flex", gap: 6 }}>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="host.example.com" style={{ ...inputStyle, width: 240 }} />
          <button type="submit" disabled={busy} style={ghostBtn}>Add domain</button>
        </form>
      ) : null}
      {err ? <ErrorLine message={err} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- roster */

interface RosterRow { id: string; sourceName: string; sourceCouncil: string | null; sourceEmail: string | null; status: string; membershipRef: string; venueId: string | null; venue: { name: string; slug: string } | null; createdAt: string }

function RosterTab({ channelKey, canAct }: { channelKey: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [status, setStatus] = useState("");
  const [council, setCouncil] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const LIMIT = 50;

  const load = useCallback((reset: boolean) => {
    setLoading(true); setErr(null);
    const nextOffset = reset ? 0 : offset;
    const input: { channelKey: string; limit: number; offset: number; status?: string; council?: string; q?: string } = { channelKey, limit: LIMIT, offset: nextOffset };
    if (status) input.status = status;
    if (council.trim()) input.council = council.trim();
    if (q.trim()) input.q = q.trim();
    const roster = trpc.channelsAdmin.roster as unknown as {
      query: (i: typeof input) => Promise<{ rows: RosterRow[]; hasMore: boolean; nextOffset: number }>;
    };
    roster.query(input)
      .then((r) => {
        setRows((prev) => (reset ? r.rows : [...prev, ...r.rows]));
        setHasMore(r.hasMore); setOffset(r.nextOffset);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load roster."))
      .finally(() => setLoading(false));
  }, [trpc, channelKey, status, council, q, offset]);

  // Reload from the top whenever the channel or the status filter changes. `load` is intentionally
  // omitted from the deps (it closes over offset/council/q, which must NOT trigger an auto-reload —
  // council/q apply only on explicit Filter submit).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOffset(0); load(true); }, [channelKey, status]);

  // Tag / untag a matched member's venue into this channel (staff curation for members mode) — the
  // audited adminActions.setVenueChannel path (closes review debt D7). Idempotent both ways.
  const setChannel = async (venueId: string, member: boolean) => {
    setErr(null);
    const mut = trpc.adminActions.setVenueChannel as unknown as { mutate: (i: { venueId: string; channelKey: string; member: boolean }) => Promise<{ ok: true }> };
    try { await mut.mutate({ venueId, channelKey, member }); }
    catch (e) { setErr(e instanceof Error ? e.message : "Tag update failed."); }
  };

  // Status actions (plan Phase 1.2 — the "live" spine): mark a matched member live, lapse a live
  // member, or remove one. The audited adminActions.setMemberStatus path; the state machine is
  // enforced server-side, so an impossible move surfaces as an error rather than a silent no-op.
  const setMemberStatus = async (memberId: string, status: "live" | "lapsed" | "removed", label: string) => {
    if (typeof window !== "undefined" && !window.confirm(`${label} this member?`)) return;
    setErr(null);
    const mut = trpc.adminActions.setMemberStatus as unknown as {
      mutate: (i: { channelKey: string; memberId: string; status: "live" | "lapsed" | "removed" }) => Promise<{ memberId: string; from: string; to: string }>;
    };
    try {
      const r = await mut.mutate({ channelKey, memberId, status });
      setRows((rs) => rs.map((row) => (row.id === r.memberId ? { ...row, status: r.to } : row)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Status update failed.");
    }
  };

  // Send (or resend) a claim invite to a matched member with an email (B3-d). Idempotent — a second
  // call just mints a fresh-expiry link. Per-row outcome feedback; the funnel status updates on reload.
  const [invite, setInvite] = useState<Record<string, string>>({});
  const INVITE_MSG: Record<string, string> = {
    sent: "Invite sent", unconfigured: "Invites not configured", not_matched: "No matched venue",
    no_email: "No email", not_invitable: "Already claimed", not_found: "Not found", send_failed: "Send failed",
  };
  const sendInvite = async (memberId: string) => {
    setErr(null);
    setInvite((m) => ({ ...m, [memberId]: "Sending…" }));
    const mut = trpc.adminActions.sendInvite as unknown as { mutate: (i: { channelKey: string; memberId: string }) => Promise<{ outcome: string; invited: boolean }> };
    try {
      const r = await mut.mutate({ channelKey, memberId });
      setInvite((m) => ({ ...m, [memberId]: INVITE_MSG[r.outcome] ?? r.outcome }));
    } catch (e) {
      setInvite((m) => ({ ...m, [memberId]: "Failed" }));
      setErr(e instanceof Error ? e.message : "Invite failed.");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <form onSubmit={(e) => { e.preventDefault(); setOffset(0); load(true); }} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter" style={selectStyle}>
          <option value="">All statuses</option>
          {MEMBER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={council} onChange={(e) => setCouncil(e.target.value)} placeholder="Council" style={{ ...inputStyle, width: 160 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…" style={{ ...inputStyle, width: 200 }} />
        <button type="submit" style={ghostBtn}>Filter</button>
      </form>

      {err ? <ErrorLine message={err} /> : null}

      {rows.length === 0 && !loading ? (
        <div style={{ color: C.muted, fontSize: 13 }}>No roster members{status || council || q ? " match those filters" : " yet"}.</div>
      ) : (
        <div style={{ display: "grid" }}>
          <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: `1px solid ${C.line}`, ...headerRow }}>
            <span style={{ flex: 2 }}>Member</span><span style={{ flex: 1 }}>Council</span><span style={{ flex: 1 }}>Status</span><span style={{ flex: 2 }}>Matched venue</span><span style={{ flex: 2 }}>Email</span>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13, alignItems: "center" }}>
              <span style={{ flex: 2, color: C.ink, fontWeight: 600 }}>{r.sourceName}<span style={{ fontFamily: F.mono, fontSize: 10, color: C.faint, marginLeft: 6 }}>{r.membershipRef}</span></span>
              <span style={{ flex: 1, color: C.inkSoft }}>{r.sourceCouncil ?? "—"}</span>
              <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Tag tone={r.status === "live" ? "ink" : "red"}>{r.status}</Tag>
                {canAct && r.venueId && (r.status === "imported" || r.status === "invited" || r.status === "claimed" || r.status === "lapsed") ? (
                  <button type="button" onClick={() => void setMemberStatus(r.id, "live", "Mark live")} style={smallGhost} title="Recognise this member as an active member (counts, lists and ranks as a member)">Mark live</button>
                ) : null}
                {canAct && r.status === "live" ? (
                  <button type="button" onClick={() => void setMemberStatus(r.id, "lapsed", "Lapse")} style={smallGhost} title="Membership lapsed — loses member priority, keeps its listing">Lapse</button>
                ) : null}
                {canAct && r.status !== "removed" ? (
                  <button type="button" onClick={() => void setMemberStatus(r.id, "removed", "Remove")} style={smallGhost} title="Remove from the roster (terminal)">Remove</button>
                ) : null}
              </span>
              <span style={{ flex: 2, color: C.inkSoft, display: "flex", alignItems: "center", gap: 8 }}>
                {r.venue ? r.venue.name : <em style={{ color: C.faint }}>unmatched</em>}
                {canAct && r.venueId ? (
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    <button type="button" onClick={() => void setChannel(r.venueId!, true)} style={smallGhost} title="Tag this venue into the channel">Tag</button>
                    <button type="button" onClick={() => void setChannel(r.venueId!, false)} style={smallGhost} title="Untag this venue from the channel">Untag</button>
                  </span>
                ) : null}
              </span>
              <span style={{ flex: 2, color: C.inkSoft, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontFamily: F.mono, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sourceEmail ?? "—"}</span>
                {canAct && r.venueId && r.sourceEmail && (r.status === "imported" || r.status === "invited") ? (
                  invite[r.id] ? (
                    <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>{invite[r.id]}</span>
                  ) : (
                    <button type="button" onClick={() => void sendInvite(r.id)} style={smallGhost} title="Email this member a claim invite">
                      {r.status === "invited" ? "Resend" : "Invite"}
                    </button>
                  )
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
      {hasMore ? <button type="button" onClick={() => load(false)} disabled={loading} style={ghostBtn}>{loading ? "…" : "Load more"}</button> : null}
    </div>
  );
}

/* --------------------------------------------------------------------- onboarding */

function OnboardingTab({ channelKey }: { channelKey: string }) {
  const trpc = useTrpc();
  const [stats, setStats] = useState<{ total: number; byStatus: Record<string, number>; byCouncil: Record<string, number> } | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStats(undefined);
    (trpc.channelsAdmin.onboarding.query({ channelKey }) as Promise<{ total: number; byStatus: Record<string, number>; byCouncil: Record<string, number> }>)
      .then((s) => !cancelled && setStats(s))
      .catch((e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : "Failed to load onboarding stats."));
    return () => { cancelled = true; };
  }, [trpc, channelKey]);

  if (err) return <ErrorLine message={err} />;
  if (!stats) return <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>;
  const councils = Object.entries(stats.byCouncil).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <div><span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 32 }}>{stats.total.toLocaleString()}</span> <span style={{ fontFamily: F.mono, fontSize: 11, textTransform: "uppercase", color: C.muted, letterSpacing: ".06em" }}>roster members</span></div>
      <div>
        <Label>Funnel</Label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          {MEMBER_STATUSES.map((s) => (
            <div key={s} style={{ border: `1px solid ${C.line}`, borderRadius: 4, padding: "10px 14px", minWidth: 86 }}>
              <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22 }}>{(stats.byStatus[s] ?? 0).toLocaleString()}</div>
              <div style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", color: C.muted, marginTop: 3 }}>{s}</div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <Label>By council</Label>
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          {councils.length === 0 ? <div style={{ fontSize: 12.5, color: C.muted }}>No members yet.</div> : councils.map(([name, n]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <span style={{ flex: 1, color: C.inkSoft }}>{name}</span>
              <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{n.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- review */

interface ReviewCandidate { venueId: string; name: string; address: string | null; slug: string | null; score: number; nameScore: number; postcode: "full" | "outward" | "none"; thin: boolean }
interface ReviewItem { memberId: string; sourceName: string; sourcePostcode: string | null; sourceAddress: string | null; sourceCouncil: string | null; status: string; bestScore: number; candidates: ReviewCandidate[] }

function ReviewTab({ channelKey, canAct }: { channelKey: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const LIMIT = 25;

  const load = useCallback((fresh: boolean) => {
    setLoading(true); setErr(null);
    const nextOffset = fresh ? 0 : offset;
    const q = trpc.channelsAdmin.reviewQueue as unknown as {
      query: (i: { channelKey: string; limit: number; offset: number; includeDismissed?: boolean }) => Promise<{ items: ReviewItem[]; hasMore: boolean; nextOffset: number }>;
    };
    q.query({ channelKey, limit: LIMIT, offset: nextOffset, includeDismissed })
      .then((r) => {
        setItems((prev) => (fresh ? r.items : [...prev, ...r.items]));
        setHasMore(r.hasMore);
        setOffset(r.nextOffset);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load the review queue."))
      .finally(() => setLoading(false));
  }, [trpc, channelKey, offset, includeDismissed]);

  // Reload from the top when the channel or the dismissed filter changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOffset(0); load(true); }, [channelKey, includeDismissed]);

  const drop = (memberId: string) => setItems((prev) => prev.filter((it) => it.memberId !== memberId));

  const confirm = async (memberId: string, venueId: string) => {
    setNote((m) => ({ ...m, [memberId]: "Confirming…" }));
    const mut = trpc.adminActions.confirmMatch as unknown as { mutate: (i: { channelKey: string; memberId: string; venueId: string }) => Promise<{ ok: true }> };
    try { await mut.mutate({ channelKey, memberId, venueId }); drop(memberId); }
    catch (e) { setNote((m) => ({ ...m, [memberId]: e instanceof Error ? e.message : "Confirm failed" })); }
  };

  const dismiss = async (memberId: string) => {
    setNote((m) => ({ ...m, [memberId]: "Dismissing…" }));
    const mut = trpc.adminActions.setMatchDismissed as unknown as { mutate: (i: { channelKey: string; memberId: string; dismissed: boolean }) => Promise<{ ok: true }> };
    try { await mut.mutate({ channelKey, memberId, dismissed: true }); drop(memberId); }
    catch (e) { setNote((m) => ({ ...m, [memberId]: e instanceof Error ? e.message : "Dismiss failed" })); }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.5, flex: 1, minWidth: 260 }}>
          Members the importer left unmatched, with candidate venues the matcher scored. Confirm the right
          one (a permanent manual match) or dismiss when none fits.
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.inkSoft }}>
          <input type="checkbox" checked={includeDismissed} onChange={(e) => setIncludeDismissed(e.target.checked)} />
          Show dismissed
        </label>
      </div>

      {err ? <ErrorLine message={err} /> : null}

      {items.length === 0 && !loading ? (
        <div style={{ color: C.muted, fontSize: 13 }}>Nothing to review — every matched member is bound.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {items.map((it) => (
            <div key={it.memberId} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 16, color: C.ink }}>{it.sourceName}</span>
                {it.sourcePostcode ? <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted }}>{it.sourcePostcode}</span> : null}
                {it.sourceCouncil ? <span style={{ fontSize: 12, color: C.muted }}>· {it.sourceCouncil}</span> : null}
                <span style={{ flex: 1 }} />
                {canAct ? (
                  note[it.memberId] ? (
                    <span style={{ fontSize: 12, color: C.muted }}>{note[it.memberId]}</span>
                  ) : (
                    <button type="button" onClick={() => void dismiss(it.memberId)} style={smallGhost} title="No candidate is correct">No match</button>
                  )
                ) : null}
              </div>
              {it.sourceAddress ? <div style={{ fontSize: 12.5, color: C.inkSoft, marginTop: 2 }}>{it.sourceAddress}</div> : null}

              {it.candidates.length === 0 ? (
                <div style={{ fontSize: 12.5, color: C.faint, marginTop: 10 }}>No plausible candidates — dismiss, or match manually once the venue exists.</div>
              ) : (
                <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                  {it.candidates.map((c) => (
                    <div key={c.venueId} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", background: "#fafafa", borderRadius: 4 }}>
                      <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, color: c.score >= 0.85 ? "#1F6B41" : C.ink, minWidth: 42 }}>{Math.round(c.score * 100)}%</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{c.name}</span>
                        {c.address ? <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{c.address}</span> : null}
                        <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, marginLeft: 8 }}>pc:{c.postcode}{c.thin ? " · thin" : ""}</span>
                      </span>
                      {canAct ? (
                        <button type="button" onClick={() => void confirm(it.memberId, c.venueId)} disabled={!!note[it.memberId]} style={smallGhost} title="Confirm this venue as the match">Confirm</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {hasMore ? <button type="button" onClick={() => load(false)} disabled={loading} style={ghostBtn}>{loading ? "…" : "Load more"}</button> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- import */

interface RosterColumn { index: number; header: string; field: string | null; via: "alias" | "override" | null }
interface RowIssue { line: number; reason: string }
interface ImportReport {
  runId: string | null; dryRun: boolean; imported: number; updated: number;
  matchedAccept: number; matchedReview: number; matchedReject: number; matchedConflict: number;
  errors: number; warnings: number; backfillCandidates: string[];
  columns: RosterColumn[]; errorsSample: RowIssue[]; warningsSample: RowIssue[];
  conflictsSample: { member: string; venueId: string }[];
}

/** The canonical fields a column may be bound to — mirrors @roam/core/membership ROSTER_FIELDS. */
const ROSTER_FIELDS = ["name", "postcode", "email", "address", "council", "phone", "ref", "town"] as const;

/**
 * Roster import — DRY RUN FIRST, always.
 *
 * A partner's roster is their record, not ours, and the first contact with a real export should not
 * also be the moment it lands in the roster of record. So the flow is: load the file → read how each
 * column was understood → fix any column by hand → rehearse → only then commit. "Commit" is disabled
 * until a rehearsal of THIS EXACT input has succeeded, so the destructive step can never be the first
 * button pressed, and editing the file or the mapping retracts the permission to commit.
 */
function ImportTab({ channelKey, canAct }: { channelKey: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  /** The csv+mapping a successful dry run was performed against — the commit button's permission. */
  const [rehearsed, setRehearsed] = useState<string | null>(null);

  const signature = `${csv}\u0000${JSON.stringify(mapping)}`;
  const canCommit = rehearsed === signature && !!report && report.errors === 0;

  const run = async (dryRun: boolean) => {
    if (!csv.trim()) return;
    setBusy(true); setErr(null);
    const mut = trpc.adminActions.importRoster as unknown as {
      mutate: (i: { channelKey: string; csv: string; dryRun: boolean; mapping?: Record<string, string> }) => Promise<ImportReport>;
    };
    try {
      const out = await mut.mutate({ channelKey, csv, dryRun, ...(Object.keys(mapping).length ? { mapping } : {}) });
      setReport(out);
      // A rehearsal grants permission to commit this exact input; a real run spends it.
      setRehearsed(dryRun ? signature : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed.");
      setReport(null); setRehearsed(null);
    } finally { setBusy(false); }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(typeof reader.result === "string" ? reader.result : "");
      setFileName(file.name);
      setReport(null); setRehearsed(null); setErr(null);
    };
    reader.onerror = () => setErr("Could not read that file.");
    reader.readAsText(file);
  };

  const remap = (header: string, field: string) => {
    setMapping((m) => ({ ...m, [header]: field }));
    setRehearsed(null); // the mapping changed — the previous rehearsal no longer describes this run
  };

  if (!canAct) return <div style={{ fontSize: 12.5, color: C.muted }}>View-only — ask an owner for acting access to import a roster.</div>;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.5 }}>
        Load the Association roster (CSV), check how each column was read, then rehearse the import.
        Nothing is written until you commit. Import is idempotent by member reference; matched venues
        with thin data enrich automatically as their pages are viewed.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={{ ...ghostBtn, display: "inline-block" }}>
          Choose CSV…
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} style={{ display: "none" }} />
        </label>
        {fileName ? <span style={{ fontFamily: F.mono, fontSize: 12, color: C.muted }}>{fileName}</span> : null}
      </div>

      <textarea
        value={csv}
        onChange={(e) => { setCsv(e.target.value); setReport(null); setRehearsed(null); }}
        placeholder={"Name,Postcode,Address,Town/City\nCaptain's Table,BT21 0HE,22 Parade,Donaghadee"}
        rows={10}
        style={{ ...inputStyle, width: "100%", fontFamily: F.mono, fontSize: 12.5, resize: "vertical" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void run(true)} disabled={busy || !csv.trim()} style={primaryBtn}>
          {busy ? "Working…" : "Rehearse (dry run)"}
        </button>
        <button type="button" onClick={() => void run(false)} disabled={busy || !canCommit} style={{ ...ghostBtn, opacity: canCommit ? 1 : 0.45, cursor: canCommit ? "pointer" : "not-allowed" }}>
          Commit import
        </button>
        {report?.dryRun ? <span style={{ fontSize: 12.5, color: C.muted }}>Nothing written — this was a rehearsal.</span> : null}
        {report && !report.dryRun ? <span style={{ fontSize: 12.5, color: "#1F6B41" }}>Imported.</span> : null}
        {report && report.errors > 0 && report.dryRun ? <span style={{ fontSize: 12.5, color: C.red }}>Fix the errors below before committing.</span> : null}
      </div>

      {err ? <ErrorLine message={err} /> : null}

      {report ? (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            {[
              ["Imported", report.imported], ["Updated", report.updated],
              ["Matched", report.matchedAccept], ["Review", report.matchedReview],
              ["Conflicts", report.matchedConflict], ["Rejected", report.matchedReject],
              ["To enrich", report.backfillCandidates.length],
              ["Errors", report.errors], ["Warnings", report.warnings],
            ].map(([label, n]) => (
              <div key={String(label)} style={{ border: `1px solid ${C.line}`, borderRadius: 4, padding: "10px 14px", minWidth: 80 }}>
                <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22 }}>{Number(n).toLocaleString()}</div>
                <div style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", color: C.muted, marginTop: 3 }}>{label}</div>
              </div>
            ))}
          </div>

          {report.columns.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              <Label>Columns read</Label>
              <div style={{ display: "grid", gap: 6 }}>
                {report.columns.map((col) => (
                  <div key={col.index} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "#fafafa", borderRadius: 4 }}>
                    <span style={{ fontFamily: F.mono, fontSize: 12, flex: 1, minWidth: 0, color: C.ink }}>{col.header}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted }}>{col.via === "override" ? "manual" : col.field ? "auto" : "not used"}</span>
                    <select
                      value={mapping[col.header] ?? col.field ?? ""}
                      onChange={(e) => remap(col.header, e.target.value)}
                      style={{ ...selectStyle, fontSize: 12.5, padding: "5px 8px" }}
                    >
                      <option value="">— carry to audit only —</option>
                      {ROSTER_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {report.conflictsSample.length ? (
            <IssueList
              label={`Withheld — venue already held by another member (${report.matchedConflict})`}
              tone="red"
              lines={report.conflictsSample.map((c) => `${c.member} → venue ${c.venueId}`)}
            />
          ) : null}
          {report.errorsSample.length ? (
            <IssueList label={`Rows skipped (${report.errors})`} tone="red" lines={report.errorsSample.map((i) => `line ${i.line}: ${i.reason}`)} />
          ) : null}
          {report.warningsSample.length ? (
            <IssueList label={`Imported with gaps (${report.warnings})`} tone="ink" lines={report.warningsSample.map((i) => `line ${i.line}: ${i.reason}`)} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A capped, scrollable list of row-level complaints from an import run. */
function IssueList({ label, lines, tone }: { label: string; lines: string[]; tone: "ink" | "red" }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Label>{label}</Label>
      <div style={{ maxHeight: 190, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 4 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ fontFamily: F.mono, fontSize: 11.5, padding: "5px 10px", color: tone === "red" ? C.red : C.inkSoft, borderTop: i ? `1px solid ${C.line}` : undefined }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- atoms */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Label>{label}</Label>
      {children}
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

function Tag({ children, tone = "ink" }: { children: React.ReactNode; tone?: "ink" | "red" }) {
  return (
    <span style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: "#fff", background: tone === "red" ? C.red : C.ink, borderRadius: 3, padding: "2px 7px" }}>
      {children}
    </span>
  );
}

const inputStyle: React.CSSProperties = { boxSizing: "border-box", padding: "9px 12px", background: "#fff", border: `1px solid ${C.lineStrong}`, borderRadius: 4, fontFamily: F.ui, fontSize: 13.5, color: C.ink, outline: "none" };
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };
const primaryBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", background: C.ink, color: "#fff", borderRadius: 4, fontFamily: F.ui, fontSize: 13.5, fontWeight: 700, textAlign: "center" };
const ghostBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "8px 14px", border: `1px solid ${C.lineStrong}`, borderRadius: 4, fontFamily: F.ui, fontSize: 13, fontWeight: 600, color: C.ink };
const smallGhost: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "5px 11px", border: `1px solid ${C.lineStrong}`, borderRadius: 3, fontFamily: F.ui, fontSize: 12, fontWeight: 600, color: C.ink };
const headerRow: React.CSSProperties = { fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: C.muted };
