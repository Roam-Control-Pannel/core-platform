/**
 * Shared style atoms for the Home sections — the native equivalents of the small
 * hoisted objects and CSS-Module classes web's Home.tsx uses (`mutedNote`, `rowSkeleton`,
 * `.iconChip`, `.row`, `.venueChip`, `.newsCard`).
 *
 * Hoisted into one module because every widget reaches for the same handful, and a
 * section's own file should read as its layout, not its palette.
 */
import { StyleSheet } from "react-native";
import { color, radius, space } from "@roam/design/tokens";
import { family } from "../../design";

export const common = StyleSheet.create({
  /** The quiet explanatory paragraph inside a section (error / empty / nudge copy). */
  mutedNote: {
    fontFamily: family.ui,
    fontSize: 13.5,
    lineHeight: 21,
    color: color.ink2,
  },
  /** Loading placeholder row — a sunken paper-2 block at list-row height. */
  rowSkeleton: {
    height: 44,
    borderRadius: radius.md,
    backgroundColor: color.paper2,
  },
  /** Section-header icon chip: the small rounded crimson-tinted glyph tile. */
  iconChip: {
    width: 26,
    height: 26,
    borderRadius: 9,
    backgroundColor: color.crimsonTint,
    alignItems: "center",
    justifyContent: "center",
  },
  /** A tappable list row inside a section. */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[3],
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: radius.md,
  },
  /** Web's `:hover` wash has no touch equivalent — this is its press state. */
  rowPressed: {
    backgroundColor: color.paper2,
  },
  /** A round avatar bubble with an initial inside (venues, chats, authors). */
  avatar: {
    borderRadius: 999,
    backgroundColor: color.crimsonTint,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: family.uiBold,
    color: color.crimson700,
  },
  /** A bordered card-shaped row (the forum topic rows, news cards). */
  outlineCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space[3],
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.card,
  },
  /** A follow chip with an initial avatar (the followed-venues row). */
  venueChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: color.paper2,
    borderWidth: 1,
    borderColor: color.line,
  },
  /** Mono uppercase eyebrow used inside sections ("EXCLUSIVE DEALS FOR YOU"). */
  eyebrow: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: color.muted,
  },
});
