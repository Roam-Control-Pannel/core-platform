/**
 * AuthorLink — renders a content author's name as a link to their profile wall (/u/[id]),
 * the connective tissue of the social graph. Used wherever a user authored something (Town
 * Hall topics & replies, profile-wall posts & comments).
 *
 * Degrades safely: when the author has no id (a deleted account → "Someone"), it renders plain
 * text rather than a dead link. Do NOT use inside another <a>/<Link> (invalid nested links) —
 * compact rows that already navigate elsewhere should keep the name as plain text.
 */
"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { townHallAuthor, type TownHallAuthor } from "../lib/townHall";

export function AuthorLink({ author, style }: { author: TownHallAuthor; style?: CSSProperties }) {
  const name = townHallAuthor(author);
  if (!author.id) return <span style={style}>{name}</span>;
  return (
    <Link href={`/u/${author.id}`} style={{ color: "inherit", textDecoration: "none", ...style }}>
      {name}
    </Link>
  );
}
