/**
 * @roam/design components — the web React component kit, ported faithfully from the
 * hi-fi handoff CSS against the shared design tokens.
 *
 * Presentation atoms (Button, Pill, Card, Stat, Seg, Rate, DistanceChip, AvatarStack)
 * are styled from token CSS vars — a token change repaints them. PollCard renders a
 * resolution computed by @roam/core (the rule lives in core, not here).
 *
 * Native equivalents are a later slice consuming the same tokens + the same core logic.
 */
export { Button, type ButtonProps, type ButtonVariant } from "./Button";
export { Pill, type PillProps, type PillVariant } from "./Pill";
export { Card, Stat, type CardProps, type StatProps } from "./Card";
export { Seg, type SegProps, type SegOption } from "./Seg";
export {
  Rate,
  DistanceChip,
  AvatarStack,
  type RateProps,
  type DistanceChipProps,
  type AvatarStackProps,
} from "./Chips";
export { PollCard, type PollCardProps, type PollOption } from "./PollCard";
export { Icon, type IconProps, type IconName } from "./Icon";
