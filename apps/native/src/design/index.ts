/**
 * The native design kit — @roam/design's component vocabulary, rebuilt in React Native
 * against the SAME token objects the web kit reads.
 *
 * packages/design ships the web React components (DOM + CSS vars); this is their native
 * counterpart, the "later slice" that package's docs describe. Tokens, semantic icon names
 * and component APIs match web deliberately, so a screen ported between surfaces is a
 * change of primitives, not a redesign.
 */
export { Card, type CardProps } from "./Card";
export { Button, type ButtonProps, type ButtonVariant } from "./Button";
export { Pill, type PillProps, type PillVariant } from "./Pill";
export { Seg, type SegProps, type SegOption } from "./Seg";
export { Icon, type IconName, type IconProps } from "./Icon";
export { text, family } from "./text";
export { sh1, shadowKey, shadowPop } from "./shadow";
