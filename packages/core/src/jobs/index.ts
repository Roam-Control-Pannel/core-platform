/**
 * @roam/core/jobs — the F2G employability board (C4) domain rules.
 *
 * Pure, framework-agnostic bits shared by the API (validation on write) and the web (labels, the
 * composer's type picker). v1 is post-and-apply-out: no applicant data is ever modelled, so there is
 * deliberately nothing here about CVs, applications, or applicant PII — only the post's own fields.
 */

/** The employment types a post may declare (soft enum; the DB check mirrors this list). */
export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "temporary",
  "apprenticeship",
  "seasonal",
  "casual",
  "internship",
  "other",
] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export function isEmploymentType(v: string | null | undefined): v is EmploymentType {
  return v != null && (EMPLOYMENT_TYPES as readonly string[]).includes(v);
}

/** Human label for an employment type — the one place the wording lives. */
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  temporary: "Temporary",
  apprenticeship: "Apprenticeship",
  seasonal: "Seasonal",
  casual: "Casual",
  internship: "Internship",
  other: "Other",
};

/**
 * Validate + normalise an apply-out URL: it must be a well-formed http(s) URL (the ONLY apply path in
 * v1). Returns the normalised absolute URL, or null when it isn't a usable http(s) link — the caller
 * rejects a post without one, keeping the "apply-out only, no applicant data" boundary intact.
 */
export function normaliseApplyUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === "" || s.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.toString();
}
