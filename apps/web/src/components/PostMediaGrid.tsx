/**
 * PostMediaGrid — a Facebook/Instagram-style photo collage for a post's images. One component,
 * used by every surface that shows post media (home feed, /feed list, a post's detail page, the
 * venue Posts tab, the dashboard preview) so multi-image posts look identical everywhere.
 *
 * Layouts (mirrors the familiar social grid):
 *   1  → one image, 3:2
 *   2  → two side-by-side, 2:1 overall
 *   3  → one tall on the left + two stacked on the right, 3:2 overall
 *   4+ → a 2×2 grid; a 5th-or-more count collapses onto the last tile as a "+N" overlay
 *
 * Every tile is object-fit:cover so nothing distorts. Presentational only — the caller wraps it in
 * whatever link/lightbox it wants (feed cards wrap the whole card in a link to the post).
 */

type Img = { url: string };

const GAP = 3;

function Tile({ url, plus }: { url: string; plus?: number }) {
  return (
    <div style={{ position: "relative", overflow: "hidden", background: "var(--paper-2)" }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
      <img src={url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {plus && plus > 0 ? (
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, background: "rgba(33,29,26,.52)", color: "#fff", display: "grid", placeItems: "center", fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.01em" }}
        >
          +{plus}
        </div>
      ) : null}
    </div>
  );
}

export function PostMediaGrid({ media }: { media: Img[] }) {
  if (!media || media.length === 0) return null;
  const shown = media.slice(0, 4);
  const extra = media.length - 4; // shown on the 4th tile when there are more than four
  const wrap: React.CSSProperties = {
    display: "grid",
    gap: GAP,
    borderRadius: "var(--r-md)",
    overflow: "hidden",
    background: "var(--card)",
  };

  if (shown.length === 1) {
    return (
      <div style={{ ...wrap, aspectRatio: "3 / 2" }}>
        <Tile url={shown[0]!.url} />
      </div>
    );
  }
  if (shown.length === 2) {
    return (
      <div style={{ ...wrap, gridTemplateColumns: "1fr 1fr", aspectRatio: "2 / 1" }}>
        <Tile url={shown[0]!.url} />
        <Tile url={shown[1]!.url} />
      </div>
    );
  }
  if (shown.length === 3) {
    return (
      <div style={{ ...wrap, gridTemplateColumns: "2fr 1fr", gridTemplateRows: "1fr 1fr", aspectRatio: "3 / 2" }}>
        <div style={{ gridRow: "1 / 3", position: "relative", overflow: "hidden", display: "grid" }}>
          <Tile url={shown[0]!.url} />
        </div>
        <Tile url={shown[1]!.url} />
        <Tile url={shown[2]!.url} />
      </div>
    );
  }
  // 4 (or more → "+N" on the last tile)
  return (
    <div style={{ ...wrap, gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", aspectRatio: "1 / 1" }}>
      {shown.map((m, i) => (
        <Tile key={m.url} url={m.url} plus={i === 3 ? extra : 0} />
      ))}
    </div>
  );
}
