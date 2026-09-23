import { describe, it, expect } from "vitest";
import { parseCsv, parseRosterCsv } from "./import.js";

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas, and \"\" escapes", () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi"""')).toEqual([["a", "b"], ["x,y", 'he said "hi"']]);
  });
  it("handles a trailing newline and CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseRosterCsv", () => {
  it("maps header variants, normalises postcode, and imports valid rows", () => {
    const csv = [
      "Trading Name,Post Code,Contact Email,Council Area,Member Ref",
      "Mario's Pizzeria,bt11aa,owner@mario.example,Belfast,ASSOC-1",
      "The Bakehouse,BT47 6XX,hello@bakehouse.example,Derry & Strabane,ASSOC-2",
    ].join("\n");
    const out = parseRosterCsv(csv);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      sourceName: "Mario's Pizzeria",
      sourcePostcode: "BT1 1AA", // normalised
      sourceEmail: "owner@mario.example",
      sourceCouncil: "Belfast",
      membershipRef: "ASSOC-1",
    });
    expect(out.rows[1]!.sourcePostcode).toBe("BT47 6XX");
    expect(out.rows[0]!.raw["Trading Name"]).toBe("Mario's Pizzeria"); // raw preserved
  });

  it("derives a stable membership_ref when the source has none (idempotent)", () => {
    const csv = "name,postcode,email\nGreggs,BT1 1AA,a@x.com";
    const a = parseRosterCsv(csv).rows[0]!.membershipRef;
    const b = parseRosterCsv(csv).rows[0]!.membershipRef;
    expect(a).toBe(b); // same input → same key (re-import is idempotent)
    expect(a.startsWith("AUTO:")).toBe(true);
  });

  it("skips a row with no name (as an error, never silently) and keeps the good rows", () => {
    const csv = "name,postcode\nGood Cafe,BT1 1AA\n,BT2 2BB";
    const out = parseRosterCsv(csv);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.sourceName).toBe("Good Cafe");
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.line).toBe(3);
  });

  it("imports a row missing postcode/email but flags it as a warning", () => {
    const csv = "name,postcode,email\nNo Contact Cafe,,";
    const out = parseRosterCsv(csv);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.sourcePostcode).toBeNull();
    expect(out.rows[0]!.sourceEmail).toBeNull();
    expect(out.warnings[0]!.reason).toMatch(/postcode \+ email/);
  });

  it("errors cleanly when there is no name column", () => {
    const out = parseRosterCsv("postcode,email\nBT1 1AA,a@x.com");
    expect(out.rows).toEqual([]);
    expect(out.errors[0]!.reason).toMatch(/no recognisable 'name'/i);
  });

  it("returns empty for empty input", () => {
    expect(parseRosterCsv("")).toEqual({ rows: [], errors: [], warnings: [], columns: [] });
  });
});

/**
 * The shapes below are taken from the REAL F2G Association sample (2026-09-23): four columns
 * (Name | Postcode | Address | Town/City), no e-mail, no membership number, and the spreadsheet
 * artifacts that came with it. Business names are altered — the Association's membership list is
 * theirs, not ours to commit — but every pathology is reproduced exactly as it appeared.
 */
describe("parseRosterCsv — pathologies from the real Association sample", () => {
  const header = "Name,Postcode,Address,Town/City";

  it("recovers a postcode wearing a spreadsheet escape artifact (`BT43 7EP)", () => {
    // The real file carries a leading backtick on one row. Left in, it became the outward code
    // "`BT43", which matches no venue address, so the member was silently rejected with no candidates.
    const out = parseRosterCsv(`${header}\nCorner Spar,\`BT43 7EP,82 Frys Road,Ballymena`);
    expect(out.rows[0]!.sourcePostcode).toBe("BT43 7EP");
    // The only complaint is the absent e-mail column; the postcode itself is now clean.
    expect(out.warnings.some((w) => /postcode/i.test(w.reason))).toBe(false);
  });

  it("maps Town/City as a recognised column without mistaking it for the council", () => {
    const out = parseRosterCsv(`${header}\nHarbour Grill,BT21 0HE,22 Parade,Donaghadee`);
    const town = out.columns.find((c) => c.header === "Town/City");
    expect(town).toMatchObject({ field: "town", via: "alias" });
    // The sample's town disagrees with its own postcodes, so it must never become the council.
    expect(out.rows[0]!.sourceCouncil).toBeNull();
    expect(out.rows[0]!.raw["Town/City"]).toBe("Donaghadee"); // kept verbatim for audit
  });

  it("reports a cell that is not a postcode rather than blocking candidates on it", () => {
    const out = parseRosterCsv(`${header}\nMobile Unit,n/a,Various,Belfast`);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.sourcePostcode).toBeNull(); // "NA" would ILIKE-match a huge slice of venues
    expect(out.warnings[0]!.reason).toMatch(/not a recognisable UK postcode/);
    // ...and it is reported ONCE, not also as a plain "missing postcode".
    expect(out.warnings.filter((w) => w.line === 2 && /postcode/i.test(w.reason))).toHaveLength(1);
  });

  it("extracts a postcode from a cell that holds a whole address", () => {
    const out = parseRosterCsv(`${header}\nThe Old Mill,"3 Tullygarvan Mill, BT23 6FR",3 Tullygarvan Mill,Comber`);
    expect(out.rows[0]!.sourcePostcode).toBe("BT23 6FR");
  });

  it("survives a BOM, CRLF, a leading-space name and a trailing blank line", () => {
    const csv = `\uFEFF${header}\r\n Riverside Bakery ,BT14 7AA,181 Crumlin Road,Belfast\r\n\r\n`;
    const out = parseRosterCsv(csv);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.sourceName).toBe("Riverside Bakery"); // trimmed, and the BOM did not eat "Name"
    expect(out.columns[0]).toMatchObject({ header: "Name", field: "name" });
  });

  it("flags every row for a missing e-mail — the sample has no e-mail column at all", () => {
    const out = parseRosterCsv(`${header}\nHarbour Grill,BT21 0HE,22 Parade,Donaghadee`);
    expect(out.rows[0]!.sourceEmail).toBeNull();
    expect(out.warnings[0]!.reason).toMatch(/missing email/);
    // Without an e-mail the invite path returns `no_email` — so this warning is the whole onboarding
    // funnel telling us it cannot start. It must never be silent.
    expect(out.columns.some((c) => c.field === "email")).toBe(false);
  });

  it("derives a ref per row when there is no membership number (none until 2027)", () => {
    const csv = [
      header,
      "Apache Lisburn,BT27 5AJ,83 Sloan Street,Lisburn",
      "Apache Banbridge,BT32 3HA,80 Newry Street,Banbridge",
    ].join("\n");
    const out = parseRosterCsv(csv);
    const refs = out.rows.map((r) => r.membershipRef);
    expect(refs[0]!.startsWith("AUTO:")).toBe(true);
    expect(new Set(refs).size).toBe(2); // chain branches must not collide on one key
  });
});

describe("parseRosterCsv — operator column mapping", () => {
  it("binds an unrecognised header to a field, making a new export shape config not code", () => {
    const csv = "Outlet Description,Post Code\nHarbour Grill,BT21 0HE";
    const before = parseRosterCsv(csv);
    expect(before.errors[0]!.reason).toMatch(/no recognisable 'name'/i);
    expect(before.columns[0]).toMatchObject({ header: "Outlet Description", field: null, via: null });

    const after = parseRosterCsv(csv, { mapping: { "Outlet Description": "name" } });
    expect(after.errors).toEqual([]);
    expect(after.rows[0]!.sourceName).toBe("Harbour Grill");
    expect(after.columns[0]).toMatchObject({ field: "name", via: "override" });
  });

  it("honours an explicit decision to ignore a column the aliases would have claimed", () => {
    const csv = "Name,Company\nHarbour Grill,Harbour Holdings Ltd";
    // "Company" is a `name` alias; here it is the parent entity, not the trading name.
    const out = parseRosterCsv(csv, { mapping: { Company: "" } });
    expect(out.rows[0]!.sourceName).toBe("Harbour Grill");
    expect(out.columns[1]).toMatchObject({ field: null, via: "override" });
    expect(out.rows[0]!.raw["Company"]).toBe("Harbour Holdings Ltd"); // still audited
  });

  it("ignores a mapping to a field that does not exist rather than inventing one", () => {
    const out = parseRosterCsv("Name,Notes\nHarbour Grill,vegan", { mapping: { Notes: "nonsense" } });
    expect(out.columns[1]!.field).toBeNull();
    expect(out.rows).toHaveLength(1);
  });
});
