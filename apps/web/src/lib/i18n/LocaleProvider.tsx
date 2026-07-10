/**
 * LocaleProvider — the client half of the locale system (see runtime.ts for the architecture).
 *
 * Mounted once in the root layout. First render is ALWAYS English (matching the server HTML, so
 * hydration never mismatches); after mount it reads the preference cookie and, if the user chose
 * another language, loads that catalogue and re-renders. It also keeps <html lang> honest —
 * that attribute is what tells Chrome/Edge/Safari's built-in translation the page's real
 * language, which is how untranslated community content stays browser-translatable.
 *
 * Catalogues: en.json is bundled statically (it's the fallback and the default). Translated
 * catalogues are dynamic imports registered in CATALOGUES (added in PR 7), so a user only ever
 * downloads the language they use; missing keys fall back to English per-message via the
 * getMessageFallback hook rather than crashing the render.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../../messages/en.json";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  setRuntimeLocale,
  type Locale,
} from "./runtime";

type Messages = typeof en;

/** Locale → catalogue loader. Translated languages register here as they ship (PR 7). */
const CATALOGUES: Partial<Record<Locale, () => Promise<{ default: Messages }>>> = {};

interface LocaleSetting {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  options: typeof SUPPORTED_LOCALES;
}

const LocaleContext = createContext<LocaleSetting>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  options: SUPPORTED_LOCALES,
});

/** The language picker's hook (Settings). */
export function useLocaleSetting(): LocaleSetting {
  return useContext(LocaleContext);
}

function readCookieLocale(): Locale | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  const value = match?.[1] ?? "";
  return isSupportedLocale(value) ? value : null;
}

/** English fills any hole a translated catalogue leaves, message by message (not namespace). */
function deepMerge<T>(base: T, override: unknown): T {
  if (typeof base !== "object" || base === null || typeof override !== "object" || override === null) {
    return (override ?? base) as T;
  }
  const out = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/** Push the active locale everywhere non-React code looks: <html lang> + the runtime helpers. */
function broadcastLocale(locale: Locale, messages: Messages) {
  document.documentElement.lang = locale;
  setRuntimeLocale(locale, { ...messages.common.time, someone: messages.common.someone, roamMember: messages.common.roamMember });
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ locale: Locale; messages: Messages }>({
    locale: DEFAULT_LOCALE,
    messages: en,
  });

  const activate = useCallback(async (locale: Locale) => {
    const load = CATALOGUES[locale];
    // English (or a locale whose catalogue hasn't shipped) → the bundled English messages.
    const messages = load ? deepMerge(en, (await load()).default) : en;
    broadcastLocale(locale, messages);
    setActive({ locale, messages });
  }, []);

  // After hydration, adopt the saved preference (first render stayed English on purpose).
  useEffect(() => {
    const saved = readCookieLocale();
    if (saved && saved !== DEFAULT_LOCALE) void activate(saved);
  }, [activate]);

  const setLocale = useCallback(
    (locale: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
      void activate(locale);
    },
    [activate],
  );

  return (
    <LocaleContext.Provider value={{ locale: active.locale, setLocale, options: SUPPORTED_LOCALES }}>
      <NextIntlClientProvider
        locale={active.locale}
        messages={active.messages}
        timeZone="Europe/London"
        // A missing key renders its English text (en.json is merged in as the base), so this
        // only fires for a genuinely unknown key — show the key rather than throwing.
        getMessageFallback={({ key, namespace }) => (namespace ? `${namespace}.${key}` : key)}
      >
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
