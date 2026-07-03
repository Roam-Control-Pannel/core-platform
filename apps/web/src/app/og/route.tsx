/**
 * /og — the dynamic 1200×630 OpenGraph card generator. Every public page whose entity has no
 * content image of its own points its og:image here (see seo.ts social()/ogCardUrl), so a shared
 * Roam link ALWAYS unfurls as a branded designed card — entity title big, an optional context
 * badge ("TOWN HALL · DARLINGTON") and subtitle, the Roam wordmark — instead of the tiny square
 * logo placeholder.
 *
 * Rendered with next/og's ImageResponse (satori): flexbox-only inline styles, bundled Inter as
 * the (only) font — hierarchy comes from size + the brand palette (packages/design tokens,
 * hex-inlined here because this runs outside the CSS-var pipeline). Inputs are query params,
 * length-capped; text is rendered as text (JSX), never markup. Response is CDN-cacheable.
 */
import { ImageResponse } from "next/og";

export const dynamic = "force-dynamic";

// Brand palette — packages/design/src/tokens/color.ts values, inlined.
const CRIMSON = "#C2123F";
const CRIMSON_700 = "#9D0F33";
const PAPER = "#F6F3EF";
const INK = "#211D1A";
const INK_2 = "#4D463F";
const MUTED = "#857C72";
const LINE = "#E4DED6";

function param(searchParams: URLSearchParams, key: string, max: number): string {
  return (searchParams.get(key) ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const title = param(searchParams, "title", 120) || "Roam";
  const sub = param(searchParams, "sub", 140);
  const badge = param(searchParams, "badge", 48);

  const siteHost = (process.env.NEXT_PUBLIC_SITE_URL ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  // Long titles step down so they fit in three lines at most.
  const titleSize = title.length > 80 ? 46 : title.length > 44 ? 56 : 68;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          padding: "64px 72px 56px",
          position: "relative",
          fontFamily: "Inter, sans-serif",
        }}
      >
        {/* Crimson brand strip along the bottom edge. */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 14, background: CRIMSON, display: "flex" }} />

        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 26, height: 26, borderRadius: 26, background: CRIMSON, display: "flex" }} />
          <div style={{ fontSize: 38, color: INK, letterSpacing: -1, display: "flex" }}>Roam</div>
        </div>

        {/* Badge · title · subtitle */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 1020 }}>
          {badge ? (
            <div
              style={{
                fontSize: 22,
                color: CRIMSON_700,
                letterSpacing: 3,
                textTransform: "uppercase",
                display: "flex",
              }}
            >
              {badge}
            </div>
          ) : null}
          <div style={{ fontSize: titleSize, color: INK, lineHeight: 1.12, letterSpacing: -1.5, display: "flex" }}>{title}</div>
          {sub ? <div style={{ fontSize: 28, color: INK_2, lineHeight: 1.35, display: "flex" }}>{sub}</div> : null}
        </div>

        {/* Footer: the site host, quietly. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${LINE}`,
            paddingTop: 22,
          }}
        >
          <div style={{ fontSize: 23, color: MUTED, display: "flex" }}>{siteHost || "Roam — your town, together"}</div>
          <div style={{ fontSize: 23, color: CRIMSON_700, display: "flex" }}>Discover what&apos;s local</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
