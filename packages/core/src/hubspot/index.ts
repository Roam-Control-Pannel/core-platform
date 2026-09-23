/**
 * @roam/core/hubspot — turning the Association's CRM records into roster rows (F2G plan 2.3).
 *
 * Pure and framework-free: HubSpot JSON in, typed roster rows out. No network, no DB — so the rules
 * that decide what a member IS can be tested without a token, which matters because we cannot reach
 * their portal from here.
 *
 * WHY THE CRM AT ALL. The Association's roster spreadsheet has no e-mail column and no membership
 * number (none until 2027), which leaves the onboarding funnel with no credential to activate on and
 * no stable key to re-import against — `membership_ref` would fall back to a key derived from
 * name+postcode, fields they edit (see ../membership/import.ts). HubSpot answers both: its object ids
 * are immutable, and the contact e-mail lives there. So:
 *
 *   identity   → company id           (channel_members.source_system_id, unique per channel)
 *   credential → contact e-mail       (channel_members.source_email, the invite/activation target)
 *
 * COMPANIES LEAD. A member is a COMPANY — the trading business we match to a Roam venue. Its
 * associated CONTACTS exist only to supply a person to write to. A company with no contact is still a
 * member; it simply has no self-serve path until someone gives it one.
 *
 * PROPERTY NAMES ARE CONFIGURATION, NOT CODE. The defaults below are HubSpot's own standard company
 * and contact properties, which is the best available assumption — but a portal can rename or replace
 * any of them with a custom property, and we have not seen theirs. Every field is therefore resolved
 * through a mapping that env can override, so a mismatch is a settings change rather than a release.
 */
import { sanitiseSourcePostcode } from "../membership/index.js";

/** Which HubSpot property feeds each roster field. Values are HubSpot property names. */
export interface HubspotPropertyMap {
  name: string;
  address: string;
  town: string;
  postcode: string;
  phone: string;
  /** Contact-side properties. */
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * HubSpot's standard properties. `zip` is the postcode (HubSpot is US-centric in its naming, not its
 * data), `address` is street line 1, `city` is the town. These are what a portal has unless someone
 * deliberately replaced them.
 */
export const DEFAULT_PROPERTY_MAP: HubspotPropertyMap = {
  name: "name",
  address: "address",
  town: "city",
  postcode: "zip",
  phone: "phone",
  email: "email",
  firstName: "firstname",
  lastName: "lastname",
};

/** The company properties a sync must request (HubSpot returns only what you ask for). */
export function companyProperties(map: HubspotPropertyMap): string[] {
  return unique([map.name, map.address, map.town, map.postcode, map.phone, "hs_lastmodifieddate"]);
}

/** The contact properties a sync must request. */
export function contactProperties(map: HubspotPropertyMap): string[] {
  return unique([map.email, map.firstName, map.lastName, map.phone, "createdate", "hs_lastmodifieddate"]);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim() !== ""))];
}

/** A HubSpot object as the CRM API returns it: an id plus a flat property bag. */
export interface HubspotObject {
  id: string;
  properties?: Record<string, string | null | undefined> | undefined;
}

/** One company, reduced to the fields a roster row needs. */
export interface HubspotCompany {
  id: string;
  name: string;
  address: string | null;
  town: string | null;
  postcode: string | null;
  phone: string | null;
  /** Every property HubSpot returned, verbatim, for channel_members.source_raw. */
  raw: Record<string, string>;
}

/** One contact, reduced to what identifies a person to write to. */
export interface HubspotContact {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  /** HubSpot's createdate, used only to break ties deterministically. */
  createdAt: string | null;
}

function prop(o: HubspotObject, key: string): string | null {
  const v = o.properties?.[key];
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function rawOf(o: HubspotObject): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.properties ?? {})) {
    if (v !== null && v !== undefined) raw[k] = String(v);
  }
  return raw;
}

/**
 * Parse one company record. Returns null when it has no usable name — a roster row is required to
 * have one (channel_members.source_name is NOT NULL), and a nameless company cannot be matched to a
 * venue or shown to anyone. The caller counts these rather than discarding them silently.
 */
export function parseCompany(
  record: HubspotObject,
  map: HubspotPropertyMap = DEFAULT_PROPERTY_MAP,
): HubspotCompany | null {
  const id = String(record?.id ?? "").trim();
  if (!id) return null;
  const name = prop(record, map.name);
  if (!name) return null;
  return {
    id,
    name,
    address: prop(record, map.address),
    town: prop(record, map.town),
    postcode: sanitiseSourcePostcode(prop(record, map.postcode)) || null,
    phone: prop(record, map.phone),
    raw: rawOf(record),
  };
}

/** Parse one contact record. Unlike a company, a contact with no e-mail is still returned — the
 * caller needs to know a person exists even when there is no address to invite them at. */
export function parseContact(
  record: HubspotObject,
  map: HubspotPropertyMap = DEFAULT_PROPERTY_MAP,
): HubspotContact | null {
  const id = String(record?.id ?? "").trim();
  if (!id) return null;
  const first = prop(record, map.firstName);
  const last = prop(record, map.lastName);
  const name = [first, last].filter(Boolean).join(" ") || null;
  return {
    id,
    email: prop(record, map.email),
    name,
    phone: prop(record, map.phone),
    createdAt: prop(record, "createdate"),
  };
}

/** Which contact was chosen for a company, and whether the choice was ambiguous. */
export interface ContactChoice {
  contact: HubspotContact | null;
  /** How many associated contacts carried an e-mail. >1 means the rule below had to pick. */
  emailCandidates: number;
}

/**
 * Choose THE roster contact for a company.
 *
 * The Association has not told us which contact is the membership contact where a company has several
 * — it is the one open question in this integration. Rather than guess differently on every run, the
 * rule is fixed and deterministic: prefer a contact with an e-mail (no e-mail means no invite, which
 * is the whole point of reading contacts), then the OLDEST by `createdate`, then the lowest id.
 *
 * Oldest-first rather than newest is deliberate. The chosen e-mail becomes the activation credential,
 * so it must not move under a member's feet: adding a new contact in HubSpot should never silently
 * redirect an invite, whereas the founding contact is stable. When the Association answers, this
 * becomes a configured property instead — and until then `emailCandidates` is reported per run so the
 * size of the ambiguity is measured rather than assumed.
 */
export function pickRosterContact(contacts: readonly HubspotContact[]): ContactChoice {
  const withEmail = contacts.filter((c) => !!c.email);
  const pool = withEmail.length > 0 ? withEmail : contacts;
  if (pool.length === 0) return { contact: null, emailCandidates: 0 };
  const sorted = [...pool].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
    const tb = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
    const va = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta; // undated sorts last, never first
    const vb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    if (va !== vb) return va - vb;
    return a.id.localeCompare(b.id);
  });
  return { contact: sorted[0] ?? null, emailCandidates: withEmail.length };
}

/** A roster row ready to write to channel_members. */
export interface HubspotRosterRow {
  sourceSystem: "hubspot";
  sourceSystemId: string;
  membershipRef: string;
  sourceName: string;
  sourceAddress: string | null;
  sourcePostcode: string | null;
  sourceEmail: string | null;
  sourcePhone: string | null;
  sourceRaw: Record<string, unknown>;
}

/**
 * Build the roster row for a company plus its chosen contact.
 *
 * `membership_ref` is `HS:<company id>`. That column is NOT NULL and unique per channel, and with no
 * membership numbers to put in it the alternative is the derived name+postcode key — which changes
 * whenever the Association fixes a typo, turning the next sync's update into a duplicate insert.
 * Deriving it from the immutable company id makes it stable by construction, and legible: a row's ref
 * says where it came from. `source_council` is deliberately NOT set from the CRM's town field — the
 * council is derived downstream from the matched venue's FSA record (migration 0154).
 */
export function toRosterRow(company: HubspotCompany, contact: HubspotContact | null): HubspotRosterRow {
  return {
    sourceSystem: "hubspot",
    sourceSystemId: company.id,
    membershipRef: `HS:${company.id}`,
    sourceName: company.name,
    sourceAddress: company.address,
    sourcePostcode: company.postcode,
    sourceEmail: contact?.email ?? null,
    // The company's own number first; a contact's personal number is the fallback, not the default.
    sourcePhone: company.phone ?? contact?.phone ?? null,
    sourceRaw: {
      company: company.raw,
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      town: company.town,
    },
  };
}

/**
 * Parse a `HUBSPOT_PROPERTY_MAP` env value — `rosterField=hubspotProperty`, comma separated, e.g.
 * "postcode=postal_code,name=trading_name". Unknown roster fields are ignored rather than fatal: a
 * typo in configuration must not take the nightly sync down, and the run reports what it used.
 */
export function parsePropertyMap(raw: string | null | undefined): HubspotPropertyMap {
  const map: HubspotPropertyMap = { ...DEFAULT_PROPERTY_MAP };
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [field, property] = pair.split("=").map((s) => s.trim());
    if (!field || !property) continue;
    if (Object.hasOwn(map, field)) map[field as keyof HubspotPropertyMap] = property;
  }
  return map;
}
