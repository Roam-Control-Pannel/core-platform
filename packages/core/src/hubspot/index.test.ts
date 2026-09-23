import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROPERTY_MAP,
  companyProperties,
  contactProperties,
  parseCompany,
  parseContact,
  parsePropertyMap,
  pickRosterContact,
  toRosterRow,
  type HubspotContact,
} from "./index.js";

const company = (props: Record<string, string | null>, id = "8001") => ({ id, properties: props });

describe("parseCompany", () => {
  it("maps HubSpot's standard properties onto the roster fields", () => {
    const out = parseCompany(company({
      name: "Harbour Grill",
      address: "22 Parade",
      city: "Donaghadee",
      zip: "BT21 0HE",
      phone: "028 9188 1234",
    }));
    expect(out).toMatchObject({
      id: "8001",
      name: "Harbour Grill",
      address: "22 Parade",
      town: "Donaghadee",
      postcode: "BT21 0HE",
      phone: "028 9188 1234",
    });
  });

  it("sanitises the postcode through the same rule the CSV path uses", () => {
    // `zip` is free text in a CRM exactly as it is in a spreadsheet, so it gets the same treatment:
    // junk characters dropped, a postcode extracted from a fuller address, nonsense rejected.
    expect(parseCompany(company({ name: "A", zip: "`BT43 7EP" }))!.postcode).toBe("BT43 7EP");
    expect(parseCompany(company({ name: "B", zip: "3 Tullygarvan Mill, BT23 6FR" }))!.postcode).toBe("BT23 6FR");
    expect(parseCompany(company({ name: "C", zip: "n/a" }))!.postcode).toBeNull();
  });

  it("refuses a record with no name or no id rather than inventing one", () => {
    expect(parseCompany(company({ name: null, zip: "BT1 1AA" }))).toBeNull();
    expect(parseCompany(company({ name: "   " }))).toBeNull();
    expect(parseCompany({ id: "", properties: { name: "Nameless" } })).toBeNull();
  });

  it("keeps every returned property verbatim for audit", () => {
    const out = parseCompany(company({ name: "Harbour Grill", custom_membership_tier: "gold" }));
    expect(out!.raw["custom_membership_tier"]).toBe("gold");
  });

  it("honours a custom property map", () => {
    const map = { ...DEFAULT_PROPERTY_MAP, name: "trading_name", postcode: "postal_code" };
    const out = parseCompany({ id: "9", properties: { trading_name: "Nica Nica", postal_code: "BT12 5AH" } }, map);
    expect(out).toMatchObject({ name: "Nica Nica", postcode: "BT12 5AH" });
  });
});

describe("parseContact", () => {
  it("joins the name parts and keeps the e-mail", () => {
    const out = parseContact({ id: "c1", properties: { firstname: "Ada", lastname: "Ni Mhaoil", email: "ada@x.example" } });
    expect(out).toMatchObject({ id: "c1", name: "Ada Ni Mhaoil", email: "ada@x.example" });
  });

  it("returns a contact even with no e-mail — the caller needs to know a person exists", () => {
    const out = parseContact({ id: "c2", properties: { firstname: "Sam" } });
    expect(out).toMatchObject({ id: "c2", name: "Sam", email: null });
  });
});

describe("pickRosterContact", () => {
  const c = (id: string, email: string | null, createdAt: string | null): HubspotContact =>
    ({ id, email, name: id, phone: null, createdAt });

  it("prefers a contact with an e-mail — no e-mail means no invite", () => {
    const choice = pickRosterContact([c("2", null, "2020-01-01T00:00:00Z"), c("1", "a@x.example", "2024-01-01T00:00:00Z")]);
    expect(choice.contact?.id).toBe("1");
    expect(choice.emailCandidates).toBe(1);
  });

  it("breaks a tie on the OLDEST contact, so the credential cannot move under a member's feet", () => {
    // Adding a new contact in HubSpot must never silently redirect where an invite is sent.
    const choice = pickRosterContact([
      c("new", "new@x.example", "2026-05-01T00:00:00Z"),
      c("old", "old@x.example", "2019-03-02T00:00:00Z"),
    ]);
    expect(choice.contact?.id).toBe("old");
    expect(choice.emailCandidates).toBe(2); // ...and it reports that it had to choose
  });

  it("is deterministic when dates are missing or equal", () => {
    const a = pickRosterContact([c("b", "b@x.example", null), c("a", "a@x.example", null)]);
    const b = pickRosterContact([c("a", "a@x.example", null), c("b", "b@x.example", null)]);
    expect(a.contact?.id).toBe("a");
    expect(b.contact?.id).toBe("a"); // input order cannot change the answer
  });

  it("falls back to an e-mail-less contact, and reports none when there are no contacts", () => {
    expect(pickRosterContact([c("x", null, null)]).contact?.id).toBe("x");
    expect(pickRosterContact([])).toEqual({ contact: null, emailCandidates: 0 });
  });
});

describe("toRosterRow", () => {
  const harbour = parseCompany(company({ name: "Harbour Grill", address: "22 Parade", city: "Donaghadee", zip: "BT21 0HE" }))!;

  it("keys the row on the immutable company id, not on anything the Association edits", () => {
    const row = toRosterRow(harbour, null);
    expect(row).toMatchObject({ sourceSystem: "hubspot", sourceSystemId: "8001", membershipRef: "HS:8001" });

    // The whole point: correcting the name or postcode in the CRM must not change the key, because a
    // changed key turns the next sync's UPDATE into a duplicate INSERT.
    const corrected = parseCompany(company({ name: "Harbour Grill Ltd", address: "22 The Parade", city: "Donaghadee", zip: "BT21 0HF" }))!;
    expect(toRosterRow(corrected, null).membershipRef).toBe(row.membershipRef);
  });

  it("takes the e-mail from the contact and prefers the company's own phone", () => {
    const withPhone = parseCompany(company({ name: "Harbour Grill", phone: "028 1111 1111" }))!;
    const contact = parseContact({ id: "c1", properties: { email: "owner@x.example", phone: "07700 900000" } })!;
    const row = toRosterRow(withPhone, contact);
    expect(row.sourceEmail).toBe("owner@x.example");
    expect(row.sourcePhone).toBe("028 1111 1111"); // the business line, not someone's mobile
  });

  it("never sets the council from the CRM's town", () => {
    // The council is derived downstream from the MATCHED venue's FSA record (migration 0154); the
    // real sample proved a partner's town field disagrees with its own postcodes.
    const row = toRosterRow(harbour, null) as unknown as Record<string, unknown>;
    expect(row["sourceCouncil"]).toBeUndefined();
    expect((row["sourceRaw"] as Record<string, unknown>)["town"]).toBe("Donaghadee"); // kept for audit
  });
});

describe("property map configuration", () => {
  it("requests exactly the properties it will read, plus the modification stamp", () => {
    expect(companyProperties(DEFAULT_PROPERTY_MAP)).toEqual(["name", "address", "city", "zip", "phone", "hs_lastmodifieddate"]);
    expect(contactProperties(DEFAULT_PROPERTY_MAP)).toContain("email");
    expect(contactProperties(DEFAULT_PROPERTY_MAP)).toContain("createdate");
  });

  it("parses an env override, so a renamed property is configuration not a release", () => {
    const map = parsePropertyMap("postcode=postal_code, name=trading_name");
    expect(map.postcode).toBe("postal_code");
    expect(map.name).toBe("trading_name");
    expect(map.town).toBe("city"); // untouched fields keep the default
  });

  it("ignores a malformed or unknown entry rather than taking the nightly sync down", () => {
    const map = parsePropertyMap("nonsense=x,,postcode,=y,phone=phone_number");
    expect(map).toMatchObject({ ...DEFAULT_PROPERTY_MAP, phone: "phone_number" });
  });

  it("returns the defaults for an unset value", () => {
    expect(parsePropertyMap(null)).toEqual(DEFAULT_PROPERTY_MAP);
    expect(parsePropertyMap("")).toEqual(DEFAULT_PROPERTY_MAP);
  });
});
