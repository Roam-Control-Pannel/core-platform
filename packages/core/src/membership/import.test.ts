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
    expect(parseRosterCsv("")).toEqual({ rows: [], errors: [], warnings: [] });
  });
});
