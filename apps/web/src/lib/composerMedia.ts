/**
 * Composer media helpers — the shared bits behind "Instagram-grade" composers (wall,
 * business posts, marketplace listings): pulling image Files out of drag-drop and
 * clipboard-paste events, and reordering a media list. Pure; the composers own their
 * upload loops and state.
 */

/** The image files in a drop/paste payload (ignores text, links, non-images). */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
}

/** A copy of `arr` with the item at `index` moved one step left (-1) or right (+1). */
export function moveItem<T>(arr: T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir;
  if (index < 0 || index >= arr.length || to < 0 || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Small round overlay-button style shared by the thumb controls (remove / move). */
export const thumbButtonStyle: React.CSSProperties = {
  border: "none",
  cursor: "pointer",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "rgba(33,29,26,.72)",
  color: "#fff",
  fontSize: 12,
  lineHeight: 1,
  display: "grid",
  placeItems: "center",
  padding: 0,
};
