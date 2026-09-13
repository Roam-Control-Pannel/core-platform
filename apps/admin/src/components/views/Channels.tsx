/**
 * Channels — Roam HQ's marketplace-channel console (F2G B4a). Three tabs:
 *   Config     — edit a channel's theme / logo / surface / sections / nav + its domain map, and the
 *                open↔members membership flip (behind a confirm; it hides non-member venues).
 *   Roster     — browse the channel's channel_members (status / council / name search, paged).
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

type Tab = "config" | "roster" | "onboarding" | "import";

interface NavItem { key: string; href: string; labelKey: string }
interface ChannelInfo {
  id: string; key: string; name: string; tagline: string | null; isDefault: boolean;
  theme: { brand?: string; accent?: string; paper?: string; ink?: string };
  logoUrl: string | null; membershipMode: "open" | "members";
  nav: NavItem[]; sections: Record<string, boolean>; surface: "roam" | "storefront";
}

const KNOWN_SECTIONS = ["storefront", "explore", "suppliers", "jobs", "townHall", "market", "deals", "events"];
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
          {(["config", "roster", "onboarding", "import"] as Tab[]).map((t) => (
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
              <span style={{ flex: 1 }}><Tag tone={r.status === "live" ? "ink" : "red"}>{r.status}</Tag></span>
              <span style={{ flex: 2, color: C.inkSoft, display: "flex", alignItems: "center", gap: 8 }}>
                {r.venue ? r.venue.name : <em style={{ color: C.faint }}>unmatched</em>}
                {canAct && r.venueId ? (
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    <button type="button" onClick={() => void setChannel(r.venueId!, true)} style={smallGhost} title="Tag this venue into the channel">Tag</button>
                    <button type="button" onClick={() => void setChannel(r.venueId!, false)} style={smallGhost} title="Untag this venue from the channel">Untag</button>
                  </span>
                ) : null}
              </span>
              <span style={{ flex: 2, color: C.inkSoft, fontFamily: F.mono, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sourceEmail ?? "—"}</span>
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

/* ------------------------------------------------------------------------- import */

interface ImportReport { runId: string | null; imported: number; updated: number; matchedAccept: number; matchedReview: number; matchedReject: number; errors: number; warnings: number; backfillCandidates: string[] }

function ImportTab({ channelKey, canAct }: { channelKey: string; canAct: boolean }) {
  const trpc = useTrpc();
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const run = async () => {
    if (!csv.trim()) return;
    setBusy(true); setErr(null); setReport(null);
    const mut = trpc.adminActions.importRoster as unknown as { mutate: (i: { channelKey: string; csv: string }) => Promise<ImportReport> };
    try { setReport(await mut.mutate({ channelKey, csv })); }
    catch (e) { setErr(e instanceof Error ? e.message : "Import failed."); }
    finally { setBusy(false); }
  };

  if (!canAct) return <div style={{ fontSize: 12.5, color: C.muted }}>View-only — ask an owner for acting access to import a roster.</div>;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.5 }}>
        Paste the Association roster CSV (header row + one member per row). It imports idempotently by
        member reference, runs the matcher, and reports the outcome. Matched venues with thin data
        enrich automatically as their pages are viewed.
      </div>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder={"name,postcode,email,ref\nMario's Pizzeria,BT1 1AA,owner@mario.example,ASSOC-1"}
        rows={10}
        style={{ ...inputStyle, width: "100%", fontFamily: F.mono, fontSize: 12.5, resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={() => void run()} disabled={busy || !csv.trim()} style={primaryBtn}>{busy ? "Importing…" : "Import roster"}</button>
        {report ? <span style={{ fontSize: 12.5, color: "#1F6B41" }}>Done.</span> : null}
      </div>
      {err ? <ErrorLine message={err} /> : null}
      {report ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
          {[
            ["Imported", report.imported], ["Updated", report.updated],
            ["Matched", report.matchedAccept], ["Review", report.matchedReview],
            ["Rejected", report.matchedReject], ["To enrich", report.backfillCandidates.length],
            ["Errors", report.errors], ["Warnings", report.warnings],
          ].map(([label, n]) => (
            <div key={String(label)} style={{ border: `1px solid ${C.line}`, borderRadius: 4, padding: "10px 14px", minWidth: 80 }}>
              <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22 }}>{Number(n).toLocaleString()}</div>
              <div style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", color: C.muted, marginTop: 3 }}>{label}</div>
            </div>
          ))}
        </div>
      ) : null}
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
