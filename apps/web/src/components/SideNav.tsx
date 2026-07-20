/**
 * SideNav — the profile + shortcuts navigation, Facebook-style. A persistent left RAIL on desktop
 * (≥980px, where the TopBar's condensed nav sits alongside it) and a slide-out DRAWER on phones,
 * opened by the hamburger in the TopBar. One shortcut list drives both, so every app area — Events,
 * Friends, Marketplace, Deals, Basecamp, Settings — finally has a front door beyond the five tabs.
 *
 * Public-friendly: the rail shows for signed-out visitors too (the public areas navigate fine); the
 * profile card adapts to a "Sign in" prompt. Open/close state lives in a tiny context so the TopBar
 * toggle and the drawer share it; the drawer closes on navigation and locks body scroll while open.
 */
"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon, type IconName } from "@roam/design";
import { useSession } from "./TrpcProvider";
import { useMe } from "./MeProvider";
import { AuthModal } from "./AuthModal";
import { useSavedPlaces } from "../lib/savedPlaces";
import { useCurrentPlace } from "../lib/currentPlace";
import styles from "./SideNav.module.css";

/* ── open/close context (shared by the TopBar toggle + the drawer) ───────────────────────── */

const SideNavContext = createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
  open: false,
  setOpen: () => {},
});

export function SideNavProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <SideNavContext.Provider value={{ open, setOpen }}>{children}</SideNavContext.Provider>;
}

export function useSideNav() {
  return useContext(SideNavContext);
}

/** The hamburger button — rendered in the TopBar, visible only on phones (rail replaces it on desktop). */
export function SideNavToggle() {
  const { setOpen } = useSideNav();
  const t = useTranslations("chrome.sideNav");
  return (
    <button type="button" className={styles.toggle} aria-label={t("openMenu")} onClick={() => setOpen(true)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
}

/* ── shortcut model ──────────────────────────────────────────────────────────────────────── */

interface Shortcut {
  href: string;
  labelKey: string;
  icon: IconName;
  /** Path prefixes that light this item as active. */
  match: string[];
}

const SHORTCUTS: Shortcut[] = [
  { href: "/explore", labelKey: "explore", icon: "place", match: ["/explore", "/venue"] },
  { href: "/town-hall", labelKey: "townHall", icon: "landmark", match: ["/town-hall", "/discover"] },
  { href: "/events", labelKey: "events", icon: "event", match: ["/events"] },
  { href: "/events?new=1", labelKey: "createEvent", icon: "plus", match: [] },
  { href: "/plans", labelKey: "plans", icon: "plan", match: ["/plans"] },
  { href: "/friends", labelKey: "friends", icon: "users", match: ["/friends"] },
  { href: "/threads", labelKey: "messages", icon: "chat", match: ["/threads"] },
  { href: "/market", labelKey: "marketplace", icon: "shop", match: ["/market"] },
  { href: "/deals", labelKey: "deals", icon: "tag", match: ["/deals"] },
  { href: "/basecamp", labelKey: "basecamp", icon: "widgets", match: ["/basecamp"] },
  { href: "/notifications", labelKey: "notifications", icon: "bell", match: ["/notifications"] },
  { href: "/settings", labelKey: "settings", icon: "settings", match: ["/settings", "/account"] },
];

function isActive(pathname: string, match: string[]): boolean {
  return match.some((m) => pathname === m || pathname.startsWith(`${m}/`) || pathname.startsWith(`${m}?`));
}

/* ── the rail + drawer ───────────────────────────────────────────────────────────────────── */

export function SideNav() {
  const { open, setOpen } = useSideNav();
  const pathname = usePathname() ?? "/";
  const t = useTranslations("chrome.sideNav");

  // Close the drawer whenever the route changes (a shortcut was tapped).
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const body = <SideNavBody pathname={pathname} />;

  return (
    <>
      <aside className={styles.rail} aria-label={t("label")}>
        {body}
      </aside>
      {open ? (
        <div className={styles.drawerRoot}>
          <button type="button" className={styles.scrim} aria-label={t("close")} onClick={() => setOpen(false)} />
          <aside className={styles.drawer} aria-label={t("label")}>
            {body}
          </aside>
        </div>
      ) : null}
    </>
  );
}

function SideNavBody({ pathname }: { pathname: string }) {
  const t = useTranslations("chrome.sideNav");
  return (
    <nav className={styles.nav} aria-label={t("label")}>
      <ProfileCard />
      <div className={styles.list}>
        {SHORTCUTS.map((s) => (
          <Link key={s.labelKey} href={s.href} className={`${styles.item} ${isActive(pathname, s.match) ? styles.active : ""}`}>
            <span className={styles.itemIcon} aria-hidden>
              <Icon name={s.icon} size={18} />
            </span>
            {t(s.labelKey)}
          </Link>
        ))}
      </div>
      <YourPlaces />
    </nav>
  );
}

/** The user's saved places — tapping one re-roots browsing to that town and opens Explore. */
function YourPlaces() {
  const t = useTranslations("chrome.sideNav");
  const { saved } = useSavedPlaces();
  const { setPlace } = useCurrentPlace();
  const { setOpen } = useSideNav();
  const router = useRouter();

  if (saved.length === 0) return null;

  return (
    <div className={styles.places}>
      <div className={styles.sectionLabel}>{t("yourPlaces")}</div>
      {saved.slice(0, 8).map((p) => (
        <button
          key={p.id}
          type="button"
          className={styles.item}
          onClick={() => {
            setPlace(p);
            setOpen(false);
            router.push("/explore");
          }}
        >
          <span className={styles.itemIcon} aria-hidden>
            <Icon name="place" size={18} />
          </span>
          <span className={styles.placeName}>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

function ProfileCard() {
  const t = useTranslations("chrome.sideNav");
  const session = useSession();
  const me = useMe();
  const [authOpen, setAuthOpen] = useState(false);

  if (!session) {
    return (
      <>
        <div className={styles.signedOut}>
          <div className={styles.signedOutTitle}>{t("signedOutTitle")}</div>
          <div className={styles.signedOutSub}>{t("signedOutSub")}</div>
          <button type="button" className={styles.signInBtn} onClick={() => setAuthOpen(true)}>
            {t("signIn")}
          </button>
        </div>
        <AuthModal
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
          intro={t("signInSub")}
        />
      </>
    );
  }

  const name = me?.displayName?.trim() || (me?.handle ? `@${me.handle}` : t("you"));
  return (
    <Link href="/account" className={styles.profile}>
      {me?.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- small avatar; next/image is overkill in the chrome
        <img src={me.avatarUrl} alt="" className={styles.avatar} />
      ) : (
        <span className={styles.avatarFallback} aria-hidden>
          <Icon name="person" size={18} />
        </span>
      )}
      <span className={styles.profileText}>
        <span className={styles.profileName}>{name}</span>
        <span className={styles.profileSub}>{t("viewProfile")}</span>
      </span>
    </Link>
  );
}
