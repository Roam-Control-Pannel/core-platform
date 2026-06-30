/**
 * UserSearch — find people by name or @handle (the Instagram/LinkedIn-style search). A debounced
 * search box over profiles.search, rendering result rows. It's presentation-flexible so the same
 * component serves two surfaces:
 *   • the Friends page — each row links to the profile and shows Message / Add-friend actions
 *     (pass `trailing` + `linkToProfile`).
 *   • the chat "New chat" composer — each row toggles selection (pass `onRowClick` + `selectedIds`).
 *
 * Public data: profiles.search is a public discovery surface (profiles_read RLS = world-readable),
 * so search works signed-out too; the row actions handle their own auth gating.
 */
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTrpc } from "./TrpcProvider";

export interface SearchedPerson {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
}

export function personName(p: { displayName: string | null; handle: string | null }): string {
  if (p.displayName && p.displayName.trim()) return p.displayName.trim();
  if (p.handle && p.handle.trim()) return `@${p.handle.trim()}`;
  return "Roam member";
}

export function PersonAvatar({ p, size }: { p: { displayName: string | null; handle: string | null; avatarUrl: string | null }; size: number }) {
  if (p.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
    return <img src={p.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.42, flexShrink: 0 }}>
      {personName(p).replace(/^@/, "").charAt(0).toUpperCase() || "·"}
    </span>
  );
}

export function UserSearch({
  placeholder = "Search people by name or @handle",
  excludeIds,
  selectedIds,
  onRowClick,
  trailing,
  linkToProfile = false,
  autoFocus = false,
}: {
  placeholder?: string;
  excludeIds?: string[];
  selectedIds?: string[];
  onRowClick?: (p: SearchedPerson) => void;
  trailing?: (p: SearchedPerson) => ReactNode;
  linkToProfile?: boolean;
  autoFocus?: boolean;
}) {
  const trpc = useTrpc();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchedPerson[] | null>(null);
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const gen = ++genRef.current;
    const search = trpc.profiles.search as unknown as {
      query: (i: { q: string }) => Promise<{ people: SearchedPerson[] }>;
    };
    const t = setTimeout(() => {
      search
        .query({ q: term })
        .then((r) => {
          if (genRef.current !== gen) return;
          setResults(r.people ?? []);
          setLoading(false);
        })
        .catch(() => {
          if (genRef.current !== gen) return;
          setResults([]);
          setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [q, trpc]);

  const exclude = new Set(excludeIds ?? []);
  const shown = (results ?? []).filter((p) => !exclude.has(p.id));
  const selected = new Set(selectedIds ?? []);

  return (
    <div>
      <div style={{ position: "relative" }}>
        <span aria-hidden style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", fontSize: 15 }}>⌕</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          style={{
            width: "100%", boxSizing: "border-box", padding: "11px 12px 11px 34px",
            background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-full)",
            fontFamily: "var(--ui)", fontSize: 16, color: "var(--ink)", outline: "none",
          }}
        />
      </div>

      {q.trim().length >= 2 ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          {loading && results === null ? (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <div style={{ height: 44, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
              <div style={{ height: 44, borderRadius: "var(--r-md)", background: "var(--paper-2)" }} />
            </div>
          ) : shown.length === 0 ? (
            <p style={{ color: "var(--ink-2)", fontSize: 13.5, margin: "var(--space-2) 2px", lineHeight: 1.5 }}>
              No one found for “{q.trim()}”. Try a different name or @handle.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-1)" }}>
              {shown.map((p) => (
                <PersonRow
                  key={p.id}
                  p={p}
                  selected={selected.has(p.id)}
                  {...(onRowClick ? { onClick: () => onRowClick(p) } : {})}
                  {...(linkToProfile ? { href: `/u/${p.handle ?? p.id}` } : {})}
                  {...(trailing ? { trailing: trailing(p) } : {})}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PersonRow({
  p,
  selected,
  onClick,
  href,
  trailing,
}: {
  p: SearchedPerson;
  selected: boolean;
  onClick?: () => void;
  href?: string;
  trailing?: ReactNode;
}) {
  const inner = (
    <>
      <PersonAvatar p={p} size={38} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {personName(p)}
        </span>
        {p.handle ? <span style={{ display: "block", fontSize: 12, color: "var(--muted)" }}>@{p.handle}</span> : null}
      </span>
      {onClick ? (
        <span
          aria-hidden
          style={{
            width: 22, height: 22, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center",
            border: `1.5px solid ${selected ? "var(--crimson)" : "var(--line-2)"}`,
            background: selected ? "var(--crimson)" : "transparent",
            color: "#fff", fontSize: 13,
          }}
        >
          {selected ? "✓" : ""}
        </span>
      ) : null}
      {trailing ?? null}
    </>
  );

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "8px 8px",
    borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit",
    background: selected ? "var(--crimson-tint)" : "transparent",
  };

  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={{ all: "unset", cursor: "pointer", boxSizing: "border-box", width: "100%", ...rowStyle }}>
        {inner}
      </button>
    );
  }
  if (href) {
    return (
      <div style={rowStyle}>
        <Link href={href} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
          <PersonAvatar p={p} size={38} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {personName(p)}
            </span>
            {p.handle ? <span style={{ display: "block", fontSize: 12, color: "var(--muted)" }}>@{p.handle}</span> : null}
          </span>
        </Link>
        {trailing ?? null}
      </div>
    );
  }
  return <div style={rowStyle}>{inner}</div>;
}
