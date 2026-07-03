/**
 * Link unfurl — fetch a URL server-side and extract its OpenGraph preview (domain, title, image)
 * for Town Hall link posts. Runs untrusted user input through our server, so it is SSRF-HARDENED:
 *
 *   - only http/https;
 *   - the hostname is DNS-resolved and EVERY resolved IP is checked against private/reserved ranges
 *     (loopback, RFC1918, link-local, CGNAT, IPv6 ULA/link-local, v4-mapped) BEFORE we fetch it;
 *   - redirects are followed MANUALLY, re-validating the host at each hop (the classic SSRF bypass
 *     is a public URL that 30x-redirects to 169.254.169.254 / 127.0.0.1);
 *   - a 6s total timeout and a 512KB body cap bound the work;
 *   - only text/html is parsed (an image URL is accepted as its own thumbnail).
 *
 * Best-effort: any failure returns null (or a domain-only preview), never throws to the caller.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LinkPreview {
  url: string;
  domain: string;
  title: string | null;
  imageUrl: string | null;
}

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;

/** True for loopback / private / reserved addresses we must never fetch server-side. */
function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (/^fe[89ab]/.test(low)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(low)) return true; // fc00::/7 unique-local
    const mapped = low.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable → treat as unsafe
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Reject the host unless it's a public address (checks IP literals + all DNS answers). */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase();
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked address");
    return;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new Error("blocked host");
  }
  const answers = await lookup(host, { all: true });
  if (answers.length === 0) throw new Error("no address");
  for (const a of answers) if (isPrivateIp(a.address)) throw new Error("blocked address");
}

function domainOf(u: URL): string {
  return u.hostname.replace(/^www\./, "");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, Math.min(c.length, MAX_BYTES - off)), off);
    off += c.length;
    if (off >= MAX_BYTES) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Read a <meta property|name="prop" content="…"> value (either attribute order). */
function metaTag(html: string, prop: string): string | null {
  const p = escapeRe(prop);
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, "i"));
  const b = a ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, "i"));
  return b && b[1] ? decodeEntities(b[1]) : null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m && m[1] ? decodeEntities(m[1].trim()) : null;
}

/** Fetch + parse a URL's preview. Returns null when it can't be fetched safely. */
export async function unfurl(rawUrl: string): Promise<LinkPreview | null> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return null;
  }
  const signal = AbortSignal.timeout(6000);

  try {
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") return null;
      await assertPublicHost(current.hostname);

      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "User-Agent": "RoamBot/1.0 (+https://www.roam-local.com)", Accept: "text/html,*/*" },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current); // may be relative
        continue;
      }
      if (!res.ok) return { url: current.toString(), domain: domainOf(current), title: null, imageUrl: null };

      const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
      if (ctype.startsWith("image/")) {
        return { url: current.toString(), domain: domainOf(current), title: null, imageUrl: current.toString() };
      }
      if (!ctype.includes("html")) {
        return { url: current.toString(), domain: domainOf(current), title: null, imageUrl: null };
      }

      const html = await readCapped(res);
      const title = metaTag(html, "og:title") ?? titleTag(html);
      let image = metaTag(html, "og:image") ?? metaTag(html, "twitter:image") ?? metaTag(html, "og:image:url");
      if (image) {
        try {
          image = new URL(image, current).toString();
        } catch {
          image = null;
        }
      }
      return {
        url: current.toString(),
        domain: domainOf(current),
        title: title ? title.slice(0, 200) : null,
        imageUrl: image,
      };
    }
    return null; // too many redirects
  } catch {
    // Blocked host, DNS failure, timeout, network error — fall back to a domain-only preview.
    return { url: current.toString(), domain: domainOf(current), title: null, imageUrl: null };
  }
}
