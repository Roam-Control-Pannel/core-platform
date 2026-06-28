/**
 * TabBar — the mobile bottom tab bar (Discovery design's .tabbar). Phones only; on desktop
 * the TopBar carries navigation and this is hidden (see TabBar.module.css). Renders once in
 * the root layout, after the page content, with a spacer so the fixed bar never hides the
 * last of the content.
 *
 * Same IA as the TopBar: Explore · Plans · ＋ · Chat · You. Plans and the center ＋ (Create)
 * are Stage-2 seams — present and labelled but visibly dormant, not dead links. Explore,
 * Chat (/threads) and You (/following) link to the surfaces that exist.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./TabBar.module.css";

function activeKey(pathname: string): "home" | "explore" | "townhall" | "chat" | "you" | null {
  if (pathname.startsWith("/home")) return "home";
  if (pathname === "/" || pathname.startsWith("/venue")) return "explore";
  if (pathname.startsWith("/town-hall")) return "townhall";
  if (pathname.startsWith("/threads")) return "chat";
  if (
    pathname.startsWith("/account") ||
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/following")
  )
    return "you";
  return null;
}

/* Minimal line icons (currentColor), in the calm Foundations spirit — no icon dependency. */
const icons = {
  home: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 11.5 12 4l8 7.5M6 10v9.5h12V10" />
    </svg>
  ),
  explore: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  ),
  townhall: (
    // A civic "columns" mark — the town-hall building, in the calm line-icon spirit.
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3 3.5 7.5h17zM5 11v6M9 11v6M15 11v6M19 11v6M3.5 20h17" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16.5H9l-4 3.5V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5z" />
    </svg>
  ),
  you: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5" />
    </svg>
  ),
};

export function TabBar() {
  const pathname = usePathname() ?? "/";
  const active = activeKey(pathname);

  return (
    <>
      <div className={styles.spacer} aria-hidden />
      <nav className={styles.bar} aria-label="Primary">
        <Link href="/home" className={`${styles.tab} ${active === "home" ? styles.active : ""}`}>
          {icons.home}
          Home
        </Link>
        <Link href="/" className={`${styles.tab} ${active === "explore" ? styles.active : ""}`}>
          {icons.explore}
          Explore
        </Link>
        <Link href="/town-hall" className={`${styles.tab} ${active === "townhall" ? styles.active : ""}`}>
          {icons.townhall}
          Town Hall
        </Link>
        <Link href="/threads" className={`${styles.tab} ${active === "chat" ? styles.active : ""}`}>
          {icons.chat}
          Chat
        </Link>
        <Link
          href="/account"
          className={`${styles.tab} ${active === "you" ? styles.active : ""}`}
        >
          {icons.you}
          You
        </Link>
      </nav>
    </>
  );
}
