/**
 * /og — the dynamic 1200×630 OpenGraph card generator. Every public page whose entity has no
 * content image of its own points its og:image here (see seo.ts social()/ogCardUrl), so a shared
 * Roam link ALWAYS unfurls as a branded designed card — entity title big, an optional context
 * badge ("TOWN HALL · DARLINGTON") and subtitle, the Roam wordmark — instead of the tiny square
 * logo placeholder.
 *
 * Rendered with next/og's ImageResponse (satori): flexbox-only inline styles, with Archivo (the
 * platform display/body face) bundled as WOFFs beside this route (latin + latin-ext, 400 + 700) —
 * satori can't read the CSS @import, so the font bytes are loaded and handed in explicitly (fail-safe:
 * a load error falls back to satori's default font). Hierarchy comes from weight +
 * size + the brand palette (packages/design tokens, hex-inlined here because this runs outside the
 * CSS-var pipeline). Inputs are query params, length-capped; text is rendered as text (JSX), never
 * markup. Response is CDN-cacheable.
 */
import { ImageResponse } from "next/og";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // reads the bundled WOFFs; matches the repo's other font routes

type SatoriFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };

/**
 * Load Archivo from the WOFFs bundled next to this route (latin + latin-ext, 400 + 700), memoised
 * on SUCCESS only. Satori accepts ttf/otf/woff (not woff2); @fontsource ships woff.
 *
 * FAIL-SAFE: a failed load resolves to [] (never a rejected promise) so ImageResponse falls back to
 * next/og's own default font and the card still renders — a font hiccup must never 500 a share card.
 * The memo is cleared on failure so a transient error can retry on the next request.
 */
let fontsCache: SatoriFont[] | null = null;
let fontsInFlight: Promise<SatoriFont[]> | null = null;
async function loadFonts(): Promise<SatoriFont[]> {
  if (fontsCache) return fontsCache;
  fontsInFlight ??= (async () => {
    try {
      const load = (file: string) => fetch(new URL(file, import.meta.url)).then((r) => r.arrayBuffer());
      // latin + latin-ext together cover every Roam locale's accented place names (é, ü, ł, ș, …).
      // Archivo has no Cyrillic/Greek/CJK; a title needing those falls back to the default (see GET).
      const [r, rExt, b, bExt] = await Promise.all([
        load("./archivo-400.woff"),
        load("./archivo-ext-400.woff"),
        load("./archivo-700.woff"),
        load("./archivo-ext-700.woff"),
      ]);
      fontsCache = [
        { name: "Archivo", data: r, weight: 400, style: "normal" },
        { name: "Archivo", data: rExt, weight: 400, style: "normal" },
        { name: "Archivo", data: b, weight: 700, style: "normal" },
        { name: "Archivo", data: bExt, weight: 700, style: "normal" },
      ];
      return fontsCache;
    } catch {
      return []; // fall back to next/og's default font; try again next request
    } finally {
      fontsInFlight = null;
    }
  })();
  return fontsInFlight;
}

/**
 * Archivo covers the Latin script (incl. Latin-ext) + combining marks + common punctuation/digits.
 * If the card text needs anything else (Cyrillic, Greek, CJK, …), skip the custom font so satori uses
 * its broad-coverage default rather than rendering tofu boxes for glyphs Archivo doesn't have.
 */
function archivoCovers(text: string): boolean {
  return /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u.test(text);
}

/**
 * Per-channel card palette + wordmark (A3-b). Roam is the default (packages/design token values,
 * inlined because /og runs outside the CSS-var pipeline); a branded channel gets its own palette +
 * wordmark so a shared F2G storefront link unfurls in the NI Food to Go brand, not Roam's. The f2g
 * values mirror the channels seed (migration 0116); this route can't cheaply read the DB theme per
 * request, so the launch channels' palettes are inlined here — add a channel as it launches.
 */
interface CardPalette {
  paper: string; ink: string; ink2: string; muted: string; line: string;
  brand: string; brand700: string; wordmark: string; tagline: string; envHost: string | undefined;
}
const ROAM_PALETTE: CardPalette = {
  paper: "#F6F3EF", ink: "#211D1A", ink2: "#4D463F", muted: "#857C72", line: "#E4DED6",
  brand: "#C2123F", brand700: "#9D0F33", wordmark: "Roam", tagline: "Discover what's local",
  envHost: process.env.NEXT_PUBLIC_SITE_URL,
};
const F2G_PALETTE: CardPalette = {
  paper: "#FFFDF8", ink: "#20140E", ink2: "#4D3F35", muted: "#8A7C6E", line: "#EBE3D6",
  brand: "#E8562A", brand700: "#C4431A", wordmark: "Food to Go", tagline: "Order ahead. Skip the queue.",
  envHost: process.env.NEXT_PUBLIC_F2G_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
};
function paletteFor(channel: string): CardPalette {
  return channel === "f2g" ? F2G_PALETTE : ROAM_PALETTE;
}

function param(searchParams: URLSearchParams, key: string, max: number): string {
  return (searchParams.get(key) ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const channel = (searchParams.get("channel") ?? "").trim().toLowerCase();
  const P = paletteFor(channel);
  const title = param(searchParams, "title", 120) || P.wordmark;
  const sub = param(searchParams, "sub", 140);
  const badge = param(searchParams, "badge", 48);

  const CRIMSON = P.brand;
  const CRIMSON_700 = P.brand700;
  const PAPER = P.paper;
  const INK = P.ink;
  const INK_2 = P.ink2;
  const MUTED = P.muted;
  const LINE = P.line;

  const siteHost = (P.envHost ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  // Long titles step down so they fit in three lines at most.
  const titleSize = title.length > 80 ? 46 : title.length > 44 ? 56 : 68;

  // Use Archivo when the card text is Latin-script; otherwise let satori's default cover the glyphs.
  const fonts = archivoCovers(`${title} ${sub} ${badge}`) ? await loadFonts() : [];

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
          fontFamily: "Archivo, sans-serif",
        }}
      >
        {/* Crimson brand strip along the bottom edge. */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 14, background: CRIMSON, display: "flex" }} />

        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 26, height: 26, borderRadius: 26, background: CRIMSON, display: "flex" }} />
          <div style={{ fontSize: 38, fontWeight: 700, color: INK, letterSpacing: -1, display: "flex" }}>{P.wordmark}</div>
        </div>

        {/* Badge · title · subtitle */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 1020 }}>
          {badge ? (
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: CRIMSON_700,
                letterSpacing: 3,
                textTransform: "uppercase",
                display: "flex",
              }}
            >
              {badge}
            </div>
          ) : null}
          <div style={{ fontSize: titleSize, fontWeight: 700, color: INK, lineHeight: 1.12, letterSpacing: -1.5, display: "flex" }}>{title}</div>
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
          <div style={{ fontSize: 23, color: MUTED, display: "flex" }}>{siteHost || `${P.wordmark} — your town, together`}</div>
          <div style={{ fontSize: 23, color: CRIMSON_700, display: "flex" }}>{P.tagline}</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts },
  );
}
