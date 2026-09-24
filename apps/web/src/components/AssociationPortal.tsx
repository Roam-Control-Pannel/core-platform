/**
 * AssociationPortal — /association (F2G plan 3.3). The screen the PARTNER's officers log into.
 *
 * Everything here is read-only and channel-scoped. The channel is never chosen by this component:
 * `association.me` returns whichever organisation the signed-in officer is appointed to, and every
 * other call is scoped to that same appointment server-side. So there is no channel state to get
 * wrong, and no URL to tamper with.
 *
 * Three states before any data renders — signed out, signed in but not an officer, and officer —
 * because "you are not an officer" is a legitimate answer for most signed-in users and should read
 * as an explanation rather than an error.
 *
 * Plain English, no i18n catalogue, matching its siblings (Jobs, Suppliers, Directory): this is one
 * association's private portal, not a public surface.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { formatPence } from "../lib/money";

type Tab = "overview" | "members" | "requests";

interface Me { channelId: string; channelKey: string | null; channelName: string | null; role: string }
interface Overview {
  membersTotal: number;
  funnel: { imported: number; invited: number; claimed: number; live: number; lapsed: number; removed: number };
  membersUnreachable: number;
  listedNonMembers: number;
  memberVenues: number;
  memberVenuesRated: number;
  jobsOpen: number;
  jobsTotal: number;
  suppliersApproved: number;
  suppliersPending: number;
}
interface CouncilCount { council: string; members: number }
interface OrderTotals { ordersCount: number; gmvPence: number; feesPence: number; refundedCount: number; currency: string | null }
interface VenueTotals { venueId: string; venueName: string; ordersCount: number; gmvPence: number }
interface MemberRow {
  memberId: string; business: string; memberNo: string | null;
  venueName: string | null; council: string | null; status: string; activatedAt: string | null;
}
interface MembersPage { rows: MemberRow[]; total: number }
interface FeatureRequest {
  id: string; title: string; detail: string | null; category: string;
  status: string; roamNotes: string | null; createdAt: string;
}

const STATUSES = ["imported", "invited", "claimed", "live", "lapsed", "removed"] as const;
const PAGE = 50;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function AssociationPortal() {
  const trpc = useTrpc();
  const session = useSession();

  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading, null = not an officer
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (trpc as any).association.me
      .query()
      .then((r: Me) => { if (!cancelled) setMe(r); })
      // A FORBIDDEN here is the ordinary case for a signed-in user who is not an officer.
      .catch(() => { if (!cancelled) setMe(null); });
    return () => { cancelled = true; };
  }, [trpc, session]);

  if (!session) {
    return (
      <main style={wrap}>
        <AuthPanel
          intro="Sign in to open your organisation's portal."
          emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
          onAuthed={() => {}}
        />
      </main>
    );
  }

  if (me === undefined) return <main style={wrap}><div style={skeleton} aria-hidden /></main>;

  if (me === null) {
    return (
      <main style={wrap}>
        <h1 style={h1}>Organisation portal</h1>
        <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
          This area is for officers of a partner organisation. If you should have access, ask your
          organisation&rsquo;s contact at Roam to appoint you.
        </p>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <header style={{ marginBottom: "var(--space-4)" }}>
        <h1 style={h1}>{me.channelName ?? "Your organisation"}</h1>
        <p style={{ margin: "2px 0 0", color: "var(--ink-2)", fontSize: 13 }}>
          Signed in as {me.role === "officer" ? "an officer" : "a viewer"}. Figures cover this
          organisation only.
        </p>
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: "var(--space-4)" }}>
        {(["overview", "members", "requests"] as Tab[]).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} style={tabBtn(tab === t)}>
            {t === "overview" ? "Overview" : t === "members" ? "Members" : "Requests"}
          </button>
        ))}
      </div>

      {tab === "overview" ? <OverviewTab /> : tab === "members" ? <MembersTab /> : <RequestsTab canFile={me.role === "officer"} />}
    </main>
  );
}

function OverviewTab() {
  const trpc = useTrpc();
  const [ov, setOv] = useState<Overview | undefined>(undefined);
  const [councils, setCouncils] = useState<CouncilCount[]>([]);
  const [totals, setTotals] = useState<OrderTotals | null>(null);
  const [byVenue, setByVenue] = useState<VenueTotals[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const a = (trpc as any).association;
    Promise.all([
      a.overview.query(),
      a.membersByCouncil.query(),
      a.orderTotals.query({}),
      a.orderTotalsByVenue.query({}),
    ])
      .then(([o, c, t, v]: [Overview, CouncilCount[], OrderTotals, VenueTotals[]]) => {
        if (cancelled) return;
        setOv(o); setCouncils(c ?? []); setTotals(t ?? null); setByVenue(v ?? []);
      })
      .catch((e: unknown) => !cancelled && setErr(e instanceof Error ? e.message : "Could not load the overview."));
    return () => { cancelled = true; };
  }, [trpc]);

  if (err) return <p style={errStyle}>{err}</p>;
  if (!ov) return <div style={skeleton} aria-hidden />;

  const ccy = totals?.currency ?? "gbp";
  const ratedPct = ov.memberVenues > 0 ? Math.round((ov.memberVenuesRated / ov.memberVenues) * 100) : null;

  return (
    <div style={{ display: "grid", gap: "var(--space-5)" }}>
      <section>
        <h2 style={h2}>Membership</h2>
        <div style={tileRow}>
          <Tile label="On the roster" value={ov.membersTotal} />
          <Tile label="Live" value={ov.funnel.live} />
          <Tile label="Claimed" value={ov.funnel.claimed} />
          <Tile label="Invited" value={ov.funnel.invited} />
          <Tile label="Imported" value={ov.funnel.imported} />
          <Tile label="Lapsed" value={ov.funnel.lapsed} />
        </div>
        {ov.membersUnreachable > 0 ? (
          <p style={note}>
            <strong>{ov.membersUnreachable}</strong>{" "}
            {ov.membersUnreachable === 1 ? "member is" : "members are"} still waiting to activate and
            {ov.membersUnreachable === 1 ? " has" : " have"} no email address on file. Activation is
            proved by email, so they can&rsquo;t start on their own — this is the ceiling on
            self-serve onboarding, not a sign that members are slow. Roam can activate them
            individually, and adding their addresses removes the limit.
          </p>
        ) : null}
        <p style={note}>
          {ov.listedNonMembers} non-member {ov.listedNonMembers === 1 ? "venue is" : "venues are"} listed
          on the storefront. Listed venues appear, but are never ranked or badged as members.
        </p>
      </section>

      <section>
        <h2 style={h2}>Food hygiene</h2>
        <div style={tileRow}>
          <Tile label="Member venues" value={ov.memberVenues} />
          <Tile label="With an FSA rating" value={ov.memberVenuesRated} />
          {ratedPct !== null ? <Tile label="Rated share" value={`${ratedPct}%`} /> : null}
        </div>
        <p style={note}>
          Counts only a published 0&ndash;5 rating. A venue awaiting inspection, or exempt, is not
          counted as rated.
        </p>
      </section>

      <section>
        <h2 style={h2}>Storefront</h2>
        <div style={tileRow}>
          <Tile label="Orders" value={totals?.ordersCount ?? 0} />
          <Tile label="Sales" value={formatPence(totals?.gmvPence ?? 0, ccy)} />
          <Tile label="Platform fees" value={formatPence(totals?.feesPence ?? 0, ccy)} />
          <Tile label="Refunded" value={totals?.refundedCount ?? 0} />
        </div>
        <p style={note}>All time. Sales include any delivery fee. Refunds are shown separately, not deducted.</p>

        {byVenue.length > 0 ? (
          <table style={table}>
            <thead>
              <tr><th style={th}>Member venue</th><th style={thNum}>Orders</th><th style={thNum}>Sales</th></tr>
            </thead>
            <tbody>
              {byVenue.map((v) => (
                <tr key={v.venueId}>
                  <td style={td}>{v.venueName}</td>
                  <td style={tdNum}>{v.ordersCount}</td>
                  <td style={tdNum}>{formatPence(v.gmvPence, ccy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={note}>No orders yet.</p>
        )}
      </section>

      <section>
        <h2 style={h2}>Jobs and suppliers</h2>
        <div style={tileRow}>
          <Tile label="Open jobs" value={ov.jobsOpen} />
          <Tile label="Jobs posted" value={ov.jobsTotal} />
          <Tile label="Suppliers approved" value={ov.suppliersApproved} />
          <Tile label="Suppliers pending" value={ov.suppliersPending} />
        </div>
        <p style={note}>Suppliers counted here are those added by your members.</p>
      </section>

      {councils.length > 0 ? (
        <section>
          <h2 style={h2}>Members by council</h2>
          <div style={{ display: "grid", gap: 4 }}>
            {councils.map((c) => (
              <div key={c.council} style={{ display: "flex", gap: 10, fontSize: 13.5, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                <span style={{ flex: 1, color: "var(--ink-2)" }}>{c.council}</span>
                <span style={{ fontWeight: 700 }}>{c.members}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MembersTab() {
  const trpc = useTrpc();
  const [status, setStatus] = useState<string>("");
  const [council, setCouncil] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [page, setPage] = useState<MembersPage | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [councils, setCouncils] = useState<CouncilCount[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (trpc as any).association.membersByCouncil.query()
      .then((c: CouncilCount[]) => setCouncils(c ?? []))
      .catch(() => setCouncils([]));
  }, [trpc]);

  const load = useCallback(() => {
    setErr(null);
    (trpc as any).association.members
      .query({
        status: status || null,
        council: council || null,
        query: query.trim() || null,
        limit: PAGE,
        offset,
      })
      .then((p: MembersPage) => setPage(p))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not load members."));
  }, [trpc, status, council, query, offset]);

  useEffect(() => { load(); }, [load]);

  async function download() {
    setBusy(true); setErr(null);
    try {
      const res = await (trpc as any).association.membersCsv.query({
        status: status || null,
        council: council || null,
        query: query.trim() || null,
      });
      // The CSV is built and escaped server-side; the browser only wraps it in a file.
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `members-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (res.truncated) setErr(`Export capped at ${res.rowCount} rows — narrow the filters for the rest.`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not export members.");
    } finally {
      setBusy(false);
    }
  }

  const total = page?.total ?? 0;

  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={query}
          onChange={(e) => { setOffset(0); setQuery(e.target.value); }}
          placeholder="Search business name"
          style={{ ...input, flex: 1, minWidth: 200 }}
        />
        <select value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value); }} aria-label="Status" style={input}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={council} onChange={(e) => { setOffset(0); setCouncil(e.target.value); }} aria-label="Council" style={input}>
          <option value="">All councils</option>
          {councils.map((c) => <option key={c.council} value={c.council}>{c.council}</option>)}
        </select>
        <button type="button" onClick={() => void download()} disabled={busy} style={{ ...input, cursor: busy ? "default" : "pointer" }}>
          {busy ? "Preparing…" : "Export CSV"}
        </button>
      </div>

      {err ? <p style={errStyle}>{err}</p> : null}

      {page === undefined ? (
        <div style={skeleton} aria-hidden />
      ) : page.rows.length === 0 ? (
        <p style={note}>No members match those filters.</p>
      ) : (
        <>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Business</th>
                <th style={th}>Membership no.</th>
                <th style={th}>Venue</th>
                <th style={th}>Council</th>
                <th style={th}>Status</th>
                <th style={th}>Activated</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((m) => (
                <tr key={m.memberId}>
                  <td style={td}>{m.business}</td>
                  <td style={td}>{m.memberNo ?? "—"}</td>
                  <td style={td}>{m.venueName ?? "—"}</td>
                  <td style={td}>{m.council ?? "—"}</td>
                  <td style={td}>{m.status}</td>
                  <td style={td}>{m.activatedAt ? m.activatedAt.slice(0, 10) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
            <span style={{ color: "var(--ink-2)" }}>
              {offset + 1}&ndash;{Math.min(offset + page.rows.length, total)} of {total}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} style={input}>Previous</button>
            <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} style={input}>Next</button>
          </div>
        </>
      )}

      <p style={note}>
        Member contact details are not shown here: your organisation already holds them, so the portal
        does not repeat them.
      </p>
    </div>
  );
}

/**
 * Requests — what the organisation has asked Roam for, and Roam's reply.
 *
 * `canFile` reflects the officer/viewer distinction, but only to shape the UI: the database refuses
 * a viewer's insert regardless, so hiding the composer is a courtesy rather than the control. A
 * viewer who reached the form anyway would get a clear FORBIDDEN, not a silent failure.
 */
function RequestsTab({ canFile }: { canFile: boolean }) {
  const trpc = useTrpc();
  const [rows, setRows] = useState<FeatureRequest[] | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [category, setCategory] = useState("other");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const load = useCallback(() => {
    (trpc as any).association.featureRequests
      .query()
      .then((r: FeatureRequest[]) => setRows(r ?? []))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not load requests."));
  }, [trpc]);

  useEffect(() => { load(); }, [load]);

  async function file() {
    if (title.trim().length < 3) { setErr("Give the request a short title."); return; }
    setBusy(true); setErr(null); setSent(false);
    try {
      await (trpc as any).association.createFeatureRequest.mutate({
        title: title.trim(),
        detail: detail.trim() || null,
        category,
      });
      setTitle(""); setDetail(""); setCategory("other"); setSent(true);
      load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not file the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {canFile ? (
        <section style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-3)" }}>
          <h2 style={h2}>Ask Roam for something</h2>
          <div style={{ display: "grid", gap: 8 }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What would help your members?" style={input} maxLength={140} />
            <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Any detail (optional)" rows={3} style={{ ...input, resize: "vertical" }} maxLength={4000} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={input}>
                {["storefront", "members", "jobs", "suppliers", "reporting", "other"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <button type="button" onClick={() => void file()} disabled={busy} style={{ ...input, cursor: busy ? "default" : "pointer", fontWeight: 700 }}>
                {busy ? "Sending…" : "Send to Roam"}
              </button>
              {sent ? <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Sent. Roam has been notified.</span> : null}
            </div>
          </div>
        </section>
      ) : (
        <p style={note}>
          You can read your organisation&rsquo;s requests. Filing one is an officer&rsquo;s job &mdash;
          ask Roam if your role should change.
        </p>
      )}

      {err ? <p style={errStyle}>{err}</p> : null}

      {rows === undefined ? (
        <div style={skeleton} aria-hidden />
      ) : rows.length === 0 ? (
        <p style={note}>No requests yet.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {rows.map((r) => (
            <article key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-3)" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14.5 }}>{r.title}</strong>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-2)" }}>{r.category}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11.5, fontWeight: 700 }}>{r.status.replace(/_/g, " ")}</span>
              </div>
              {r.detail ? <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{r.detail}</p> : null}
              {r.roamNotes ? (
                <p style={{ margin: "10px 0 0", padding: "8px 11px", borderRadius: 8, background: "var(--paper-2)", fontSize: 13.5, whiteSpace: "pre-wrap" }}>
                  <strong>Roam:</strong> {r.roamNotes}
                </p>
              ) : null}
              <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-2)" }}>Filed {r.createdAt.slice(0, 10)}</div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "10px 14px", minWidth: 104 }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 22 }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-2)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

const wrap: React.CSSProperties = { maxWidth: 960, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" };
const h1: React.CSSProperties = { fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0 };
const h2: React.CSSProperties = { fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, margin: "0 0 var(--space-2)" };
const skeleton: React.CSSProperties = { height: 140, borderRadius: 16, background: "var(--paper-2)" };
const note: React.CSSProperties = { color: "var(--ink-2)", fontSize: 12.5, lineHeight: 1.5, margin: "var(--space-2) 0 0" };
const errStyle: React.CSSProperties = { color: "var(--danger, #b00)", fontSize: 13.5, margin: 0 };
const tileRow: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13.5, marginTop: "var(--space-2)" };
const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--line)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-2)" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "7px 8px", borderBottom: "1px solid var(--line)" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const input: React.CSSProperties = { boxSizing: "border-box", padding: "8px 11px", background: "var(--paper)", border: "1px solid var(--line-strong, var(--line))", borderRadius: 8, fontSize: 13.5, color: "var(--ink)" };

function tabBtn(active: boolean): React.CSSProperties {
  return {
    ...input,
    cursor: "pointer",
    fontWeight: active ? 700 : 500,
    background: active ? "var(--ink)" : "var(--paper)",
    color: active ? "var(--paper)" : "var(--ink)",
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
