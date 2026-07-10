/**
 * i18n runtime state — the plain (server-safe, no "use client") half of the locale system.
 *
 * Architecture (from the pre-build audit): the app localises CLIENT-FIRST. The server always
 * renders English — every SEO surface stays English-canonical and nothing here reads cookies,
 * so no route's rendering mode or cacheability changes. LocaleProvider (the client half) reads
 * the preference cookie after hydration, loads the catalogue and calls setRuntimeLocale(); the
 * module-level state below is how plain helpers (money.ts, townHall.ts timeAgo) become
 * locale-aware without threading a hook through every call site. On the server this state is
 * simply never written, so server output is deterministically English.
 *
 * Two locales live here on purpose:
 *   - the MESSAGE locale ("en") — which catalogue is active;
 *   - the FORMATTING locale ("en-GB") — what Intl.* helpers use. English formatting is pinned
 *     to en-GB (not bare "en", which Intl treats as en-US: "Jul 5" instead of "5 Jul").
 */

/** Languages the picker offers. Labels are endonyms and are never translated. */
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English" },
  { code: "cy", label: "Cymraeg" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "pl", label: "Polski" },
  { code: "ro", label: "Română" },
  { code: "bn", label: "বাংলা" },
  { code: "gu", label: "ગુજરાતી" },
  { code: "pa", label: "ਪੰਜਾਬੀ" },
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number]["code"];

export const DEFAULT_LOCALE: Locale = "en";

/** Preference cookie (1 year, lax). Read client-side only — never on the server. */
export const LOCALE_COOKIE = "roam_locale";

export function isSupportedLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.some((l) => l.code === value);
}

/**
 * Message-locale → Intl formatting locale. English formatting is pinned to en-GB (bare "en"
 * is en-US to Intl). Every other language gets -u-nu-latn: prices and dates keep Western
 * digits (the UK context all around them) even where the language's default numbering system
 * differs (Bengali/Gujarati/Punjabi numerals) — a no-op for languages already using Latin digits.
 */
function formattingLocale(locale: string): string {
  return locale === "en" ? "en-GB" : `${locale}-u-nu-latn`;
}

/** The handful of strings plain (non-hook) helpers need, fed from the active catalogue. */
export interface RuntimeStrings {
  justNow: string;
  /** Compact duration templates with an {n} placeholder: "{n}m" / "{n}h" / "{n}d" in English. */
  minutes: string;
  hours: string;
  days: string;
  /** Fallback display name for a deleted/anonymous author (townHallAuthor). */
  someone: string;
  /** Fallback display name for a profile with no name or handle (personName). */
  roamMember: string;
}

const EN_STRINGS: RuntimeStrings = {
  justNow: "just now",
  minutes: "{n}m",
  hours: "{n}h",
  days: "{n}d",
  someone: "Someone",
  roamMember: "Roam member",
};

let current: { locale: string; format: string; strings: RuntimeStrings } = {
  locale: DEFAULT_LOCALE,
  format: formattingLocale(DEFAULT_LOCALE),
  strings: EN_STRINGS,
};

/** Called by LocaleProvider whenever the active catalogue changes. */
export function setRuntimeLocale(locale: string, strings: RuntimeStrings): void {
  current = { locale, format: formattingLocale(locale), strings };
}

/** The Intl formatting locale for dates/numbers/prices ("en-GB" until a user picks otherwise). */
export function getFormatLocale(): string {
  return current.format;
}

export function runtimeStrings(): RuntimeStrings {
  return current.strings;
}
