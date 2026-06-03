/**
 * PollCard — the crown-jewel meet-up poll, ported from `.poll-hi`.
 *
 * Option D made concrete: this component RENDERS a resolution; it does NOT compute one.
 * The tally, the winner, the tie/no-votes reason all come from @roam/core's resolvePoll
 * (pure, tested) via props. The rule lives in core; this only paints — fill bars sized to
 * each option's share, the winning option emphasised with the crimson border per the CSS.
 *
 * This is why the meet-up rule never forks across surfaces: web renders this from core's
 * Resolution; native will render its own view from the SAME core Resolution.
 */
import type { CSSProperties } from "react";

/** Mirrors @roam/core's OptionTally — kept structural so design need not depend on core. */
export interface PollOption {
  optionId: string;
  /** Display label for the option (e.g. the venue name). Caller resolves venueId→name. */
  label: string;
  count: number;
}

export interface PollCardProps {
  options: readonly PollOption[];
  /** optionId of the winning option, when the poll has resolved. */
  winnerOptionId?: string | undefined;
  style?: CSSProperties | undefined;
}

export function PollCard({ options, winnerOptionId, style }: PollCardProps) {
  const total = options.reduce((sum, o) => sum + o.count, 0);

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--crimson-tint-2)",
        borderRadius: 16,
        padding: 13,
        display: "flex",
        flexDirection: "column",
        gap: 9,
        ...style,
      }}
    >
      {options.map((o) => {
        const isWin = o.optionId === winnerOptionId;
        const pct = total > 0 ? Math.round((o.count / total) * 100) : 0;
        return (
          <div
            key={o.optionId}
            style={{
              position: "relative",
              borderRadius: 10,
              overflow: "hidden",
              border: `1px solid ${isWin ? "var(--crimson)" : "var(--line)"}`,
              padding: "9px 12px",
              fontSize: 12.5,
              fontWeight: isWin ? 600 : 400,
            }}
          >
            {/* fill bar — width animates to its % via the token motion timing */}
            <div
              style={{
                position: "absolute",
                insetBlock: 0,
                insetInlineStart: 0,
                width: `${pct}%`,
                background: isWin ? "var(--crimson-tint-2)" : "var(--crimson-tint)",
                zIndex: 0,
                transition: "width var(--motion-transition) var(--ease)",
              }}
            />
            <div
              style={{
                position: "relative",
                zIndex: 1,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{o.label}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                {o.count} · {pct}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
