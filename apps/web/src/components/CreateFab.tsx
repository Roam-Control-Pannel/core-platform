/**
 * CreateFab — the mobile "＋" create affordance (the bottom tab bar stays five live tabs; this
 * floats above it). Opens a small sheet with the real create actions now that they exist:
 * start a plan, or post to your wall. Signed-out renders nothing (both actions need an account,
 * and "post to your wall" needs your id); desktop hides it (the TopBar carries ＋Create).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useSession } from "./TrpcProvider";
import styles from "./CreateFab.module.css";

export function CreateFab() {
  const t = useTranslations("chrome.createMenu");
  const session = useSession();
  const [open, setOpen] = useState(false);
  const userId = session?.user?.id ?? null;

  if (!userId) return null;

  return (
    <>
      {open ? <button aria-label={t("close")} className={styles.backdrop} onClick={() => setOpen(false)} /> : null}
      <div className={styles.wrap}>
        {open ? (
          <div className={styles.sheet} role="menu">
            <Link href="/plans" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
              {`＋ ${t("newPlan")}`}
            </Link>
            <Link href="/events?new=1" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
              <Icon name="event" size={15} /> {t("newEvent")}
            </Link>
            <Link href={`/u/${userId}`} role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
              <Icon name="edit" size={15} /> {t("postToWall")}
            </Link>
          </div>
        ) : null}
        <button
          type="button"
          className={styles.fab}
          aria-label={open ? t("close") : t("open")}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden style={{ display: "block", transform: open ? "rotate(45deg)" : "none", transition: "transform 160ms var(--ease, ease)" }}>
            ＋
          </span>
        </button>
      </div>
    </>
  );
}
