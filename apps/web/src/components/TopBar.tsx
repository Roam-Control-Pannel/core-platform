/**
 * TopBar — the global app top bar (Discovery design's .topbar / .webnav), rendered once
 * in the root layout above every page. Brand mark + primary nav (Explore · Plans · Chat ·
 * You) + Sign in / avatar + ＋Create. It is the app's identity and primary navigation; it
 * replaces the ad-hoc links that used to live inside Explore's header.
 *
 * Honest seams: Plans and ＋Create are Stage-2 (Social) surfaces that don't exist yet, so
 * they render as visibly-dormant items rather than dead links — present in the IA, plainly
 * not active. Chat → /threads and You → /following are wired to the surfaces that DO exist.
 *
 * Sign-in lives here now (not in Explore): signed-out → a "Sign in" button opening the
 * shared AuthModal; signed-in → an avatar linking to the account-ish surface (/following).
 * On phones the nav collapses into the bottom TabBar (see TopBar.module.css media query).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "./TrpcProvider";
import { AuthModal } from "./AuthModal";
import { NotificationBell } from "./NotificationCenter";
import { SideNavToggle } from "./SideNav";
import { GlobalSearch } from "./GlobalSearch";
import { useMe } from "./MeProvider";
import { Icon, type IconName } from "@roam/design";
import styles from "./TopBar.module.css";

type NavKey = "home" | "explore" | "townhall" | "plans" | "chat" | "you";

/** Primary nav — icon + label tabs. Each item's icon is its section's glyph. */
const NAV: { key: NavKey; href: string; icon: IconName; labelKey: string }[] = [
  { key: "home", href: "/", icon: "home", labelKey: "nav.home" },
  { key: "explore", href: "/explore", icon: "search", labelKey: "nav.explore" },
  { key: "townhall", href: "/town-hall", icon: "landmark", labelKey: "nav.townHall" },
  { key: "plans", href: "/plans", icon: "plan", labelKey: "nav.plans" },
  { key: "chat", href: "/threads", icon: "chat", labelKey: "nav.chat" },
  { key: "you", href: "/account", icon: "person", labelKey: "nav.you" },
];

/** Which primary nav item the current path belongs to (for the active pill). Basecamp is
 *  deliberately NOT a nav item — it's reached from the Home header cards + rail — but it should
 *  light the Home pill, since it's Home's companion surface. */
function activeKey(pathname: string): "home" | "explore" | "townhall" | "plans" | "chat" | "you" | null {
  if (pathname === "/" || pathname.startsWith("/home") || pathname.startsWith("/basecamp")) return "home";
  if (pathname.startsWith("/explore") || pathname.startsWith("/venue")) return "explore";
  if (pathname.startsWith("/town-hall")) return "townhall";
  if (pathname.startsWith("/plans")) return "plans";
  if (pathname.startsWith("/threads")) return "chat";
  if (
    pathname.startsWith("/account") ||
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/following")
  )
    return "you";
  return null;
}

export function TopBar() {
  const t = useTranslations("chrome");
  const session = useSession();
  const me = useMe();
  const pathname = usePathname() ?? "/";
  const active = activeKey(pathname);
  const [authOpen, setAuthOpen] = useState(false);

  return (
    <header className={styles.bar}>
      {/* Menu toggle — opens the shortcuts drawer on phones (the rail replaces it on desktop). */}
      <SideNavToggle />
      {/* translate="no": the brand name is never machine-translated. */}
      <Link href="/" className={styles.brand} aria-label={t("brandHome")} translate="no">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand lockup; next/image is overkill in the chrome */}
        <img src="/roam-logo.png" alt="Roam" className={styles.logo} />
      </Link>

      <nav className={styles.nav} aria-label={t("primaryNav")}>
        {NAV.map((item) => {
          const on = active === item.key;
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`${styles.link} ${on ? styles.active : ""}`}
              aria-current={on ? "page" : undefined}
            >
              <Icon name={item.icon} size={20} />
              <span className={styles.navLabel}>{t(item.labelKey)}</span>
            </Link>
          );
        })}
      </nav>

      <GlobalSearch />

      <div className={styles.actions}>
        <Link href="/business" className={styles.forbiz}>
          {t("forBusinesses")}
        </Link>
        <Link href="/plans" className={styles.create} aria-label={t("create")}>
          <Icon name="edit" size={14} /> <span className={styles.actionLabel}>{t("create")}</span>
        </Link>
        <Link href="/market" className={styles.sell} aria-label={t("sellOnRoam")}>
          ＋ <span className={styles.actionLabel}>{t("sell")}</span>
        </Link>
        {session ? (
          <Link href="/orders" className={styles.iconBtn} aria-label={t("yourOrders")}>
            <Icon name="bag" size={17} />
          </Link>
        ) : null}
        {session ? <NotificationBell /> : null}
        {session ? (
          <Link href="/account" className={styles.avatar} aria-label={t("yourAccount")}>
            {me?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- small chrome avatar; next/image is overkill here
              <img src={me.avatarUrl} alt="" className={styles.avatarImg} />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.69-8 6v2h16v-2c0-3.31-3.58-6-8-6z" />
              </svg>
            )}
          </Link>
        ) : (
          <button className={styles.signin} onClick={() => setAuthOpen(true)}>
            {t("signIn")}
          </button>
        )}
      </div>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        emailRedirectTo={typeof window !== "undefined" ? window.location.origin + "/" : ""}
        intro={t("signInIntro")}
      />
    </header>
  );
}
