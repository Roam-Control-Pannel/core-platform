/**
 * StorefrontHeader — the NI Food to Go Association's navy top bar, shown on the f2g channel in
 * place of the Roam TopBar. Association logo + "Powered by Roam", the storefront nav (Near me ·
 * Categories · Order again · For members), and the basket entry. Co-brand, not a reskin of Roam.
 *
 * Basket note: multi-item ordering isn't built yet (checkout is one item at a time), so the basket
 * entry links to the buyer's orders for now — it becomes a live cart when that lands.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "./TrpcProvider";
import { STOREFRONT, F2G_LOGO_SRC } from "../lib/storefront";

const NAV: { key: string; href: string }[] = [
  { key: "nearMe", href: "/" },
  { key: "categories", href: "/#categories" },
  { key: "orderAgain", href: "/orders" },
  { key: "forMembers", href: "/business" },
];

export function StorefrontHeader() {
  const t = useTranslations("storefront.header");
  const session = useSession();
  const pathname = usePathname() ?? "/";

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        background: STOREFRONT.navy,
        color: STOREFRONT.onNavy,
        borderBottom: `1px solid ${STOREFRONT.navyLine}`,
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          gap: 22,
        }}
      >
        <Link href="/" aria-label={t("home")} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- small static brand lockup */}
          <img src={F2G_LOGO_SRC} alt="Food to Go Association" style={{ height: 34, width: "auto", display: "block" }} />
        </Link>

        <nav style={{ display: "flex", gap: 22, alignItems: "center", flex: 1, minWidth: 0, overflow: "hidden" }} aria-label={t("nav")}>
          {NAV.map((item) => {
            const on = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href.replace(/#.*$/, ""));
            return (
              <Link
                key={item.key}
                href={item.href}
                style={{
                  color: on ? STOREFRONT.onNavy : STOREFRONT.onNavyMuted,
                  textDecoration: "none",
                  fontWeight: 600,
                  fontSize: 14.5,
                  whiteSpace: "nowrap",
                }}
              >
                {t(`nav_${item.key}`)}
              </Link>
            );
          })}
        </nav>

        <span
          aria-hidden
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: STOREFRONT.onNavyMuted,
            whiteSpace: "nowrap",
          }}
        >
          {t("poweredByRoam")}
        </span>

        <Link
          href="/orders"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 999,
            background: STOREFRONT.yellow,
            color: STOREFRONT.yellowInk,
            fontWeight: 700,
            fontSize: 13.5,
            textDecoration: "none",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {t("basket")}
        </Link>

        {!session ? (
          <Link
            href="/account"
            style={{ color: STOREFRONT.onNavy, textDecoration: "none", fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {t("signIn")}
          </Link>
        ) : null}
      </div>
    </header>
  );
}
