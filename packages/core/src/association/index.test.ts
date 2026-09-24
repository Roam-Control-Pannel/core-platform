import { describe, it, expect } from "vitest";
import { csvField, membersToCsv, MEMBERS_CSV_COLUMNS, type PortalMemberRow } from "./index.js";

/**
 * The members CSV is the one artefact of the portal that leaves Roam entirely: an officer downloads
 * it and opens it in Excel. Its contents originate in a partner's CRM, so they are not ours to
 * trust — which makes escaping a security concern here, not a formatting one.
 */
describe("csvField", () => {
  it("leaves ordinary values alone", () => {
    expect(csvField("Bakery")).toBe("Bakery");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("quotes and doubles per RFC 4180", () => {
    expect(csvField("Smith, Jones")).toBe('"Smith, Jones"');
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  /**
   * CSV injection. Excel and Sheets evaluate a cell beginning with = + - @ as a formula, so a
   * business name from the CRM could execute when an officer opens the export. The leading
   * apostrophe is the documented defence; it shows in the cell rather than silently changing data.
   */
  it("defuses formulas without losing the original text", () => {
    // No comma, double quote or newline here, so it is prefixed but not wrapped.
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    // With a comma, it gets both treatments — prefix first, then RFC 4180 quoting around it.
    expect(csvField("=SUM(A1,A2)")).toBe(`"'=SUM(A1,A2)"`);
    expect(csvField("+1234")).toBe("'+1234");
    expect(csvField("-5")).toBe("'-5");
    expect(csvField("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
  });

  it("does not mangle a value that merely contains those characters later on", () => {
    expect(csvField("Fish + Chips")).toBe("Fish + Chips");
    expect(csvField("hello@example.com")).toBe("hello@example.com");
  });
});

const ROW: PortalMemberRow = {
  memberId: "m1",
  business: "100% Bakery",
  memberNo: "M-001",
  venueId: "v1",
  venueName: "Bakery Venue",
  venueSlug: "bakery-venue",
  council: "Belfast",
  status: "live",
  activatedAt: "2026-09-24T06:30:00.000Z",
};

describe("membersToCsv", () => {
  it("writes the agreed header and CRLF endings", () => {
    const csv = membersToCsv([ROW]);
    const [header, first] = csv.split("\r\n");
    expect(header).toBe(MEMBERS_CSV_COLUMNS.join(","));
    expect(first).toBe("100% Bakery,M-001,Bakery Venue,Belfast,live,2026-09-24");
  });

  it("carries no contact details — decision 5.2 Option A", () => {
    // The RPC has no e-mail or phone column, so this asserts the export cannot reintroduce one by
    // reading some other field into the row shape.
    const csv = membersToCsv([ROW]).toLowerCase();
    expect(csv).not.toContain("@");
    expect(csv).not.toContain("phone");
    expect(csv).not.toContain("email");
  });

  it("renders an empty list as a header row, not an empty file", () => {
    expect(membersToCsv([])).toBe(MEMBERS_CSV_COLUMNS.join(","));
  });

  it("leaves a member with no venue or activation date blank rather than 'null'", () => {
    const csv = membersToCsv([{ ...ROW, venueName: null, council: null, memberNo: null, activatedAt: null }]);
    expect(csv.split("\r\n")[1]).toBe("100% Bakery,,,,live,");
  });
});
