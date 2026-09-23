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
 * console rather than lose it.
 *
 * WHAT A REAL ROSTER LOOKS LIKE (F2G sample, 2026-09-23 — 48 rows, `Name | Postcode | Address |
 * Town/City`): no e-mail column, no phone, and NO MEMBERSHIP NUMBER — the Association is not issuing
 * those until 2027. So every assumption that the number is the key had to go: `membership_ref` falls
 * back to a DERIVED key here, and the stable identity comes from the Association's CRM instead (see
 * docs/f2g-holistic-plan.md §4, Phase 2). The parser is correspondingly defensive about cell content
 * rather than trusting a schema: see sanitiseSourcePostcode and the column mapping below.
 */
import { normaliseMembershipRef, sanitiseSourcePostcode } from "./index.js";

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

/** One source column, and what it was understood to be. Drives the import preview in Roam HQ. */
export interface RosterColumn {
  /** 0-based position in the header row. */
  index: number;
  /** The header text exactly as the file spells it (what the operator sees in the preview). */
  header: string;
  /** Canonical field this column feeds, or null when the column is carried to `raw` only. */
  field: string | null;
  /** Whether the alias table recognised it, or an operator override assigned it. */
  via: "alias" | "override" | null;
}

export interface ParsedRoster {
  rows: ParsedRosterRow[];
  errors: RosterRowIssue[]; // rows that could not be imported (no name)
  warnings: RosterRowIssue[]; // rows imported but incomplete (missing postcode/email)
  /** How each source column was interpreted — reported before anything is written. */
  columns: RosterColumn[];
}

export interface ParseRosterOptions {
  /**
   * Operator column mapping, header text → canonical field (or "" to carry a column to `raw` only).
   * Overrides the alias table. This is what makes a partner's unfamiliar export a CONFIGURATION
   * change rather than a code change: an unrecognised header is mapped in the HQ preview and the
   * same file imports correctly, with no release.
   */
  mapping?: Record<string, string> | undefined;
}

/** Header aliases → canonical field. Compared after lowercasing + stripping non-alphanumerics. */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "businessname", "tradingname", "business", "venue", "vendor", "company"],
  postcode: ["postcode", "postalcode", "zip", "zipcode"],
  email: ["email", "contactemail", "emailaddress"],
  address: ["address", "fulladdress", "streetaddress", "addressline1"],
  council: ["council", "councilarea", "localauthority", "lad", "district"],
  phone: ["phone", "telephone", "contactphone", "tel", "mobile"],
  ref: ["ref", "reference", "memberref", "membershipref", "id", "memberid", "membernumber"],
  // Recognised so the preview can say it was understood, and so it is never mistaken for a council:
  // the real F2G sample's "Town/City" disagrees with its own postcode (BT23 6FR labelled "Belfast";
  // Carryduff labelled "Belfast"), so the town is kept for audit in `raw` and the council is derived
  // downstream from the MATCHED venue's FSA local_authority, never from this column.
  town: ["town", "city", "towncity", "citytown", "posttown", "locality"],
};

/** The canonical fields a column may be mapped to — the HQ preview's override choices. */
export const ROSTER_FIELDS: readonly string[] = Object.keys(HEADER_ALIASES);

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

/**
 * Build the header→field index map from the header row. Unknown columns are ignored (but kept in
 * raw). An operator `mapping` entry wins over the alias table, including mapping a column to "" to
 * deliberately ignore one the aliases would otherwise have claimed.
 */
function mapHeaders(
  header: string[],
  mapping: Record<string, string> | undefined,
): { field: Record<number, string>; rawKey: string[]; columns: RosterColumn[] } {
  // Operator mapping is keyed by header text; compare canonically so casing/punctuation don't matter.
  const overrides = new Map<string, string>();
  for (const [h, f] of Object.entries(mapping ?? {})) overrides.set(canon(h), f.trim());

  const field: Record<number, string> = {};
  const rawKey: string[] = [];
  const columns: RosterColumn[] = [];
  header.forEach((h, i) => {
    const c = canon(h);
    rawKey[i] = h.trim() || `col${i}`;
    let assigned: string | null = null;
    let via: RosterColumn["via"] = null;

    const override = overrides.get(c);
    if (override !== undefined) {
      // "" means "carry to raw only" — an explicit, honoured decision to ignore the column.
      if (override !== "" && Object.hasOwn(HEADER_ALIASES, override)) { assigned = override; via = "override"; }
      else if (override === "") { assigned = null; via = "override"; }
    } else {
      for (const [f, aliases] of Object.entries(HEADER_ALIASES)) {
        if (aliases.includes(c)) { assigned = f; via = "alias"; break; }
      }
    }

    if (assigned) field[i] = assigned;
    columns.push({ index: i, header: rawKey[i]!, field: assigned, via });
  });
  return { field, rawKey, columns };
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
export function parseRosterCsv(text: string, opts: ParseRosterOptions = {}): ParsedRoster {
  // A UTF-8 BOM survives most spreadsheet exports and would otherwise glue itself to the first
  // header, making "\uFEFFName" unrecognisable as "name".
  const grid = parseCsv(text.replace(/^\uFEFF/, "")).filter((r) => r.some((c) => c.trim() !== ""));
  if (grid.length === 0) return { rows: [], errors: [], warnings: [], columns: [] };

  const { field, rawKey, columns } = mapHeaders(grid[0]!, opts.mapping);
  const haveName = Object.values(field).includes("name");
  if (!haveName) {
    return {
      rows: [],
      errors: [{ line: 1, reason: "No recognisable 'name' column in the header — map one in the import preview." }],
      warnings: [],
      columns,
    };
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

    // A cell that holds something which is not a postcode is reported, not quietly used as one: the
    // importer blocks candidate venues on the outward code, so a junk block key scores the member
    // against unrelated venues instead of leaving it honestly unmatched.
    const postcodeCell = get("postcode");
    const sourcePostcode = sanitiseSourcePostcode(postcodeCell) || null;
    if (postcodeCell && !sourcePostcode) {
      warnings.push({ line, reason: `Postcode "${postcodeCell}" is not a recognisable UK postcode — the member cannot be matched.` });
    }
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
    // Only report "missing postcode" when the cell was genuinely EMPTY — an unusable cell has already
    // been reported above with the offending value, and saying both would double-count the row.
    if (!sourcePostcode && !postcodeCell) missing.push("postcode");
    if (!sourceEmail) missing.push("email");
    if (missing.length) warnings.push({ line, reason: `Imported but missing ${missing.join(" + ")} (needed to match / invite).` });
  }

  return { rows, errors, warnings, columns };
}
