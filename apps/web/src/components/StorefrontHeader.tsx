/**
 * StorefrontHeader — the NI Food to Go Association's navy top bar, shown on the f2g channel in
 * place of the Roam TopBar. Association logo + "Powered by Roam", the storefront nav (Near me ·
 * Categories · Order again · For members), the basket entry and the account entry. Co-brand, not
 * a reskin of Roam.
 *
 * IA parity with the mobile TabBar (Home · Orders · You): Home = logo / Near me, Orders = Order
 * again + Basket, You = the account entry (avatar + "You" when signed in, "Sign in" otherwise).
 * On phones the TabBar carries Home/Orders/You, so the header hides its "You" there and the nav
 * scrolls sideways instead of clipping (see StorefrontHeader.module.css).
 *
 * Basket note: multi-item ordering isn't built yet (checkout is one item at a time), so the basket
 * entry links to the buyer's orders for now — it becomes a live cart when that lands.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "./TrpcProvider";
import { useMe } from "./MeProvider";
import { STOREFRONT, F2G_LOGO_SRC } from "../lib/storefront";
import styles from "./StorefrontHeader.module.css";

const NAV: { key: string; href: string }[] = [
  { key: "nearMe", href: "/" },
  { key: "categories", href: "/#categories" },
  { key: "orderAgain", href: "/orders" },
  { key: "forMembers", href: "/business" },
];

export function StorefrontHeader() {
  const t = useTranslations("storefront.header");
  const session = useSession();
  const me = useMe();
  const pathname = usePathname() ?? "/";

  const initial = (me?.displayName ?? me?.handle ?? "").replace(/^@/, "").charAt(0).toUpperCase();

  return (
    <header
      className={styles.header}
      style={
        {
          background: STOREFRONT.navy,
          color: STOREFRONT.onNavy,
          // Exposed for the module's nav fade + border (the Association palette lives in TS).
          "--sf-navy": STOREFRONT.navy,
          "--sf-navy-line": STOREFRONT.navyLine,
        } as React.CSSProperties
      }
    >
      <div className={styles.inner}>
        <Link href="/" aria-label={t("home")} className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small static brand lockup */}
          <img src={F2G_LOGO_SRC} alt="Food to Go Association" style={{ height: 34, width: "auto", display: "block" }} />
        </Link>

        <div className={styles.navWrap}>
          <nav className={styles.nav} aria-label={t("nav")}>
            {NAV.map((item) => {
              const on = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href.replace(/#.*$/, ""));
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={styles.navLink}
                  style={{ color: on ? STOREFRONT.onNavy : STOREFRONT.onNavyMuted }}
                  aria-current={on ? "page" : undefined}
                >
                  {t(`nav_${item.key}`)}
                </Link>
              );
            })}
          </nav>
        </div>

        <span aria-hidden className={styles.powered} style={{ color: STOREFRONT.onNavyMuted }}>
          {t("poweredByRoam")}
        </span>

        <Link href="/orders" className={styles.basket} style={{ background: STOREFRONT.yellow, color: STOREFRONT.yellowInk }}>
          {t("basket")}
        </Link>

        {session ? (
          <Link
            href="/account"
            className={styles.you}
            style={{ color: pathname.startsWith("/account") ? STOREFRONT.onNavy : STOREFRONT.onNavyMuted }}
            aria-current={pathname.startsWith("/account") ? "page" : undefined}
          >
            {me?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- public bucket URL; next/image adds no value here
              <img src={me.avatarUrl} alt="" className={styles.avatar} />
            ) : (
              <span aria-hidden className={styles.avatarFallback}>{initial || "·"}</span>
            )}
            {t("you")}
          </Link>
        ) : (
          <Link href="/account" className={`${styles.you} ${styles.signIn}`} style={{ color: STOREFRONT.onNavy }}>
            {t("signIn")}
          </Link>
        )}
      </div>
    </header>
  );
}
