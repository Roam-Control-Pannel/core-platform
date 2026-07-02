/**
 * CreateFab — the mobile "＋" create affordance (the bottom tab bar stays five live tabs; this
 * floats above it). Opens a small sheet with the real create actions now that they exist:
 * start a plan, or post to your wall. Signed-out renders nothing (both actions need an account,
 * and "post to your wall" needs your id); desktop hides it (the TopBar carries ＋Create).
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@roam/design";
import { useSession } from "./TrpcProvider";
import styles from "./CreateFab.module.css";

export function CreateFab() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const userId = session?.user?.id ?? null;

  if (!userId) return null;

  return (
    <>
      {open ? <button aria-label="Close create menu" className={styles.backdrop} onClick={() => setOpen(false)} /> : null}
      <div className={styles.wrap}>
        {open ? (
          <div className={styles.sheet} role="menu">
            <Link href="/plans" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
              ＋ New plan
            </Link>
            <Link href={`/u/${userId}`} role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
              <Icon name="edit" size={15} /> Post to your wall
            </Link>
          </div>
        ) : null}
        <button
          type="button"
          className={styles.fab}
          aria-label={open ? "Close create menu" : "Create"}
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
