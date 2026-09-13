/**
 * @roam/core/membership/import — parse an Association roster CSV into typed rows (F2G B3-a).
 *
 * Pure and framework-free: text in, structured rows + collected errors out. The import job upserts
 * these into channel_members (idempotent by membership_ref). Deliberately TOLERANT of the messy
 * reality of a partner's spreadsheet — header casing/variants, quoted fields, blank lines — but it
 * NEVER silently drops a data row: a row it can't use is returned as an error with its line number,
 * so the run report can show exactly what was skipped and why.
 *
 * Required to be a usable roster member: a name. Postcode and email are needed downstream (match /
 * invite) but a row missing them is still imported (flagged as a warning) so staff can fix it in the
 * console rather than lose it. See the Association request list for the field spec.
 */
import { normaliseMembershipRef, normalisePostcode } from "./index.js";

export interface ParsedRosterRow {
  sourceName: string;
  sourcePostcode: string | null;
  sourceEmail: string | null;
  sourceAddress: string | null;
  sourceCouncil: string | null;
  sourcePhone: string | null;
  /** Stable idempotency key: the source's own ref if given, else derived from name+postcode+email. */
  membershipRef: string;
  /** The untouched source row, header→value, for audit (stored in channel_members.source_raw). */
  raw: Record<string, string>;
}

export interface RosterRowIssue {
  line: number; // 1-based line number in the source file
  reason: string;
}

export interface ParsedRoster {
  rows: ParsedRosterRow[];
  errors: RosterRowIssue[]; // rows that could not be imported (no name)
  warnings: RosterRowIssue[]; // rows imported but incomplete (missing postcode/email)
}

/** Header aliases → canonical field. Compared after lowercasing + stripping non-alphanumerics. */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "businessname", "tradingname", "business", "venue", "vendor", "company"],
  postcode: ["postcode", "postcode", "postalcode", "zip", "zipcode"],
  email: ["email", "contactemail", "emailaddress"],
  address: ["address", "fulladdress", "streetaddress", "addressline1"],
  council: ["council", "councilarea", "localauthority", "lad", "district"],
  phone: ["phone", "telephone", "contactphone", "tel", "mobile"],
  ref: ["ref", "reference", "memberref", "membershipref", "id", "memberid", "membernumber"],
};

function canon(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Minimal RFC-4180 CSV parse: handles quoted fields, embedded commas/newlines, and "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  // Flush the trailing field/row (unless the file ended on a clean newline with nothing after).
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Build the header→field index map from the header row. Unknown columns are ignored (but kept in raw). */
function mapHeaders(header: string[]): { field: Record<number, string>; rawKey: string[] } {
  const field: Record<number, string> = {};
  const rawKey: string[] = [];
  header.forEach((h, i) => {
    const c = canon(h);
    rawKey[i] = h.trim() || `col${i}`;
    for (const [f, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(c)) { field[i] = f; break; }
    }
  });
  return { field, rawKey };
}

function clean(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

/** Derive a stable idempotency key when the source has no ref: name+postcode+email, normalised. */
function derivedRef(name: string, postcode: string | null, email: string | null): string {
  const parts = [name, postcode ?? "", email ?? ""].map((p) => p.toLowerCase().replace(/\s+/g, " ").trim());
  return `AUTO:${parts.join("|")}`;
}

/**
 * Parse a roster CSV. The first non-empty line is the header. Every subsequent row becomes a
 * ParsedRosterRow (or an error if it has no name / a warning if it lacks postcode/email).
 */
export function parseRosterCsv(text: string): ParsedRoster {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== "")); // drop blank lines
  if (grid.length === 0) return { rows: [], errors: [], warnings: [] };

  const { field, rawKey } = mapHeaders(grid[0]!);
  const haveName = Object.values(field).includes("name");
  if (!haveName) {
    return { rows: [], errors: [{ line: 1, reason: "No recognisable 'name' column in the header." }], warnings: [] };
  }

  const rows: ParsedRosterRow[] = [];
  const errors: RosterRowIssue[] = [];
  const warnings: RosterRowIssue[] = [];

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    const line = r + 1; // 1-based, header is line 1
    const get = (f: string): string | null => {
      const idx = Object.keys(field).find((i) => field[Number(i)] === f);
      return idx === undefined ? null : clean(cells[Number(idx)]);
    };
    const raw: Record<string, string> = {};
    cells.forEach((v, i) => { if (rawKey[i] !== undefined) raw[rawKey[i]!] = v; });

    const sourceName = get("name");
    if (!sourceName) { errors.push({ line, reason: "Row has no business name — skipped." }); continue; }

    const sourcePostcode = get("postcode") ? normalisePostcode(get("postcode")) || null : null;
    const sourceEmail = get("email");
    const refRaw = get("ref");
    const membershipRef = refRaw ? normaliseMembershipRef(refRaw) : derivedRef(sourceName, sourcePostcode, sourceEmail);

    rows.push({
      sourceName,
      sourcePostcode,
      sourceEmail,
      sourceAddress: get("address"),
      sourceCouncil: get("council"),
      sourcePhone: get("phone"),
      membershipRef,
      raw,
    });

    const missing: string[] = [];
    if (!sourcePostcode) missing.push("postcode");
    if (!sourceEmail) missing.push("email");
    if (missing.length) warnings.push({ line, reason: `Imported but missing ${missing.join(" + ")} (needed to match / invite).` });
  }

  return { rows, errors, warnings };
}
