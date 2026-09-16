/**
 * FSA ratings — Roam HQ's hygiene-rating match review (backlog #51).
 *
 * Coverage up top (food venues · linked · %), then the queue: food venues with no FSA link, each with
 * the establishments the matcher scored at its postcode. Confirm the right one (a permanent manual
 * link — the venue's badge appears on every surface immediately), search the corpus when the record
 * sits under another postcode or name, or dismiss when the FSA genuinely has no record. Every action
 * is audited server-side. Same shape as the Channels → Review tab (B4b), deliberately.
 */
import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "../TrpcProvider";
import { C, F } from "../../theme";
import { ErrorLine, Kicker, Panel } from "../ui";

interface Candidate {
  fhrsid: string;
  name: string;
  address: string | null;
  postcode: string | null;
  ratingValue: string | null;
  localAuthority: string | null;
  score: number;
  nameScore: number;
  postcodeAgreement: "full" | "outward" | "none";
}
interface Item {
  venueId: string;
  name: string;
  address: string | null;
  slug: string | null;
  postcode: string;
  decision: "accept" | "review" | "reject";
  bestScore: number;
  dismissed: boolean;
  dismissedNote: string | null;
  candidates: Candidate[];
}
interface Coverage { foodVenues: number; linked: number; dismissed: number; pct: number }

const LIMIT = 25;

export function FsaReviewView({ canAct }: { canAct: boolean }) {
  const trpc = useTrpc();
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  // Per-venue inline corpus search (for the 94-style residue: record under another postcode/name).
  const [searchOpen, setSearchOpen] = useState<Record<string, string>>({});
  const [searchHits, setSearchHits] = useState<Record<string, Candidate[]>>({});

  const loadCoverage = useCallback(() => {
    (trpc.fsaAdmin.coverage as unknown as { query: () => Promise<Coverage> })
      .query()
      .then(setCoverage)
      .catch(() => setCoverage(null));
  }, [trpc]);

  const load = useCallback(
    (fresh: boolean) => {
      setLoading(true);
      setErr(null);
      const nextOffset = fresh ? 0 : offset;
      const q = trpc.fsaAdmin.reviewQueue as unknown as {
        query: (i: { limit: number; offset: number; includeDismissed?: boolean }) => Promise<{ items: Item[]; hasMore: boolean; nextOffset: number }>;
      };
      q.query({ limit: LIMIT, offset: nextOffset, includeDismissed })
        .then((r) => {
          setItems((prev) => (fresh ? r.items : [...prev, ...r.items]));
          setHasMore(r.hasMore);
          setOffset(r.nextOffset);
        })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Failed to load the FSA review queue."))
        .finally(() => setLoading(false));
    },
    [trpc, offset, includeDismissed],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCoverage(); setOffset(0); load(true); }, [includeDismissed]);

  const drop = (venueId: string) => {
    setItems((prev) => prev.filter((it) => it.venueId !== venueId));
    loadCoverage();
  };

  const confirm = async (venueId: string, fhrsid: string) => {
    setNote((m) => ({ ...m, [venueId]: "Linking…" }));
    const mut = trpc.adminActions.confirmFsaMatch as unknown as { mutate: (i: { venueId: string; fhrsid: string }) => Promise<{ ok: true }> };
    try { await mut.mutate({ venueId, fhrsid }); drop(venueId); }
    catch (e) { setNote((m) => ({ ...m, [venueId]: e instanceof Error ? e.message : "Confirm failed" })); }
  };

  const dismiss = async (venueId: string) => {
    setNote((m) => ({ ...m, [venueId]: "Dismissing…" }));
    const mut = trpc.adminActions.setFsaMatchDismissed as unknown as { mutate: (i: { venueId: string; dismissed: boolean; note?: string }) => Promise<{ ok: true }> };
    try { await mut.mutate({ venueId, dismissed: true, note: "No FSA record for this venue" }); drop(venueId); }
    catch (e) { setNote((m) => ({ ...m, [venueId]: e instanceof Error ? e.message : "Dismiss failed" })); }
  };

  const undismiss = async (venueId: string) => {
    setNote((m) => ({ ...m, [venueId]: "Restoring…" }));
    const mut = trpc.adminActions.setFsaMatchDismissed as unknown as { mutate: (i: { venueId: string; dismissed: boolean }) => Promise<{ ok: true }> };
    try { await mut.mutate({ venueId, dismissed: false }); setNote((m) => ({ ...m, [venueId]: "" })); load(true); }
    catch (e) { setNote((m) => ({ ...m, [venueId]: e instanceof Error ? e.message : "Restore failed" })); }
  };

  const runSearch = async (venueId: string) => {
    const q = (searchOpen[venueId] ?? "").trim();
    if (q.length < 2) return;
    const s = trpc.fsaAdmin.search as unknown as { query: (i: { q: string; limit?: number }) => Promise<Candidate[]> };
    try {
      const hits = await s.query({ q, limit: 15 });
      setSearchHits((m) => ({ ...m, [venueId]: hits }));
    } catch (e) { setNote((m) => ({ ...m, [venueId]: e instanceof Error ? e.message : "Search failed" })); }
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div>
        <Kicker>Food hygiene</Kicker>
        <h1 style={{ fontFamily: F.display, fontSize: 26, fontWeight: 700, margin: "6px 0 0", color: C.ink }}>FSA ratings</h1>
      </div>

      <Panel>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
          <Stat label="Food venues" value={coverage ? String(coverage.foodVenues) : "—"} />
          <Stat label="With a rating" value={coverage ? String(coverage.linked) : "—"} />
          <Stat label="Coverage" value={coverage ? `${coverage.pct}%` : "—"} strong />
          <Stat label="Dismissed" value={coverage ? String(coverage.dismissed) : "—"} />
          <span style={{ flex: 1 }} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.inkSoft }}>
            <input type="checkbox" checked={includeDismissed} onChange={(e) => setIncludeDismissed(e.target.checked)} />
            Show dismissed
          </label>
        </div>
        <div style={{ fontSize: 13, color: C.inkSoft, lineHeight: 1.5, marginTop: 10 }}>
          Venues the nightly sync could not link with confidence, with the FSA establishments scored at their
          postcode. <b>Confirm</b> the right record (permanent; the badge shows everywhere at once), <b>search</b> the
          corpus when it sits under another postcode or trading name, or mark <b>No record</b>. A wrong rating is a
          legal exposure — when unsure, leave it.
        </div>
      </Panel>

      {err ? <ErrorLine message={err} /> : null}

      {items.length === 0 && !loading ? (
        <div style={{ color: C.muted, fontSize: 13 }}>Nothing to review — every reviewable food venue is linked or decided.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {items.map((it) => (
            <div key={it.venueId} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 14, opacity: it.dismissed ? 0.75 : 1 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 16, color: C.ink }}>{it.name}</span>
                <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted }}>{it.postcode}</span>
                {it.dismissed ? <span style={{ fontSize: 11, color: C.muted, fontFamily: F.mono }}>· dismissed{it.dismissedNote ? `: ${it.dismissedNote}` : ""}</span> : null}
                <span style={{ flex: 1 }} />
                {canAct ? (
                  note[it.venueId] ? (
                    <span style={{ fontSize: 12, color: C.muted }}>{note[it.venueId]}</span>
                  ) : it.dismissed ? (
                    <button type="button" onClick={() => void undismiss(it.venueId)} style={smallGhost} title="Put this venue back in the queue">Restore</button>
                  ) : (
                    <button type="button" onClick={() => void dismiss(it.venueId)} style={smallGhost} title="The FSA has no record for this venue">No record</button>
                  )
                ) : null}
              </div>
              {it.address ? <div style={{ fontSize: 12.5, color: C.inkSoft, marginTop: 2 }}>{it.address}</div> : null}

              {it.candidates.length === 0 ? (
                <div style={{ fontSize: 12.5, color: C.faint, marginTop: 10 }}>No plausible establishment at this postcode — search the corpus, or mark no record.</div>
              ) : (
                <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                  {it.candidates.map((c) => (
                    <CandidateRow key={c.fhrsid} c={c} canAct={canAct} busy={!!note[it.venueId]} onConfirm={() => void confirm(it.venueId, c.fhrsid)} />
                  ))}
                </div>
              )}

              {canAct ? (
                <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={searchOpen[it.venueId] ?? ""}
                      onChange={(e) => setSearchOpen((m) => ({ ...m, [it.venueId]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") void runSearch(it.venueId); }}
                      placeholder="Search the FSA corpus by trading name…"
                      style={{ flex: 1, minWidth: 220, padding: "6px 9px", border: `1px solid ${C.line}`, borderRadius: 4, fontFamily: F.ui, fontSize: 12.5 }}
                    />
                    <button type="button" onClick={() => void runSearch(it.venueId)} style={smallGhost}>Search</button>
                  </div>
                  {(searchHits[it.venueId] ?? []).map((c) => (
                    <CandidateRow key={`s-${c.fhrsid}`} c={c} canAct={canAct} busy={!!note[it.venueId]} onConfirm={() => void confirm(it.venueId, c.fhrsid)} fromSearch />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {hasMore ? <button type="button" onClick={() => load(false)} disabled={loading} style={ghostBtn}>{loading ? "…" : "Load more"}</button> : null}
    </div>
  );
}

function CandidateRow({ c, canAct, busy, onConfirm, fromSearch }: { c: Candidate; canAct: boolean; busy: boolean; onConfirm: () => void; fromSearch?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", background: "#fafafa", borderRadius: 4 }}>
      {fromSearch ? (
        <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, minWidth: 42 }}>search</span>
      ) : (
        <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, color: c.score >= 0.85 ? "#1F6B41" : C.ink, minWidth: 42 }}>{Math.round(c.score * 100)}%</span>
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{c.name}</span>
        {c.address ? <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{c.address}</span> : null}
        <span style={{ fontFamily: F.mono, fontSize: 10, color: C.muted, marginLeft: 8 }}>
          {c.postcode ?? "—"} · pc:{c.postcodeAgreement} · rating {c.ratingValue ?? "—"}{c.localAuthority ? ` · ${c.localAuthority}` : ""}
        </span>
      </span>
      {canAct ? (
        <button type="button" onClick={onConfirm} disabled={busy} style={smallGhost} title="Link this establishment to the venue (permanent)">Confirm</button>
      ) : null}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontFamily: F.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: C.muted }}>{label}</div>
      <div style={{ fontFamily: F.display, fontSize: strong ? 26 : 20, fontWeight: 700, color: C.ink }}>{value}</div>
    </div>
  );
}

const ghostBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "8px 14px", border: `1px solid ${C.lineStrong}`, borderRadius: 4, fontFamily: F.ui, fontSize: 13, fontWeight: 600, color: C.ink };
const smallGhost: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "5px 11px", border: `1px solid ${C.lineStrong}`, borderRadius: 3, fontFamily: F.ui, fontSize: 12, fontWeight: 600, color: C.ink };
