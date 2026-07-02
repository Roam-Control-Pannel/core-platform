/**
 * Icon — the single icon surface for the app. Wraps Lucide (thin, modern line icons) behind a
 * SEMANTIC name map, so components say `<Icon name="place" />` rather than importing a specific
 * glyph — one place to swap the set, rename, or restyle. Icons stroke in `currentColor`, so they
 * pick up the surrounding text colour (crimson/ink/muted) automatically, and share one stroke
 * weight for a consistent look. This replaces the emoji glyphs used across the app.
 *
 * Add a name here (mapped to a Lucide icon) as new needs appear — usage sites never import Lucide
 * directly, keeping the vocabulary curated and consistent.
 */
import type { CSSProperties } from "react";
import {
  MapPin,
  CalendarDays,
  User,
  Users,
  BarChart3,
  Image as ImageIcon,
  Camera,
  Plus,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
  X,
  MessageCircle,
  Cake,
  Gift,
  PartyPopper,
  Bell,
  Settings,
  Pencil,
  Trash2,
  Send,
  Search,
  Lock,
  Check,
  Sparkles,
  MessagesSquare,
  Ticket,
  Heart,
  Store,
  CalendarClock,
  ChevronUp,
  Landmark,
  Hand,
  Handshake,
  Inbox,
  Upload,
  Ban,
  Eye,
  Lightbulb,
  Star,
  Megaphone,
  Clock,
  TicketCheck,
  LocateFixed,
  type LucideIcon,
} from "lucide-react";

/** Semantic name → Lucide icon. Extend as the app needs more; usage stays name-based. */
const ICONS = {
  place: MapPin,
  plan: CalendarDays,
  person: User,
  users: Users,
  poll: BarChart3,
  photo: ImageIcon,
  camera: Camera,
  plus: Plus,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  arrowLeft: ArrowLeft,
  close: X,
  chat: MessageCircle,
  cake: Cake,
  gift: Gift,
  party: PartyPopper,
  bell: Bell,
  settings: Settings,
  edit: Pencil,
  trash: Trash2,
  send: Send,
  search: Search,
  lock: Lock,
  check: Check,
  sparkle: Sparkles,
  forum: MessagesSquare,
  ticket: Ticket,
  heart: Heart,
  shop: Store,
  event: CalendarClock,
  upvote: ChevronUp,
  landmark: Landmark,
  wave: Hand,
  handshake: Handshake,
  inbox: Inbox,
  upload: Upload,
  ban: Ban,
  eye: Eye,
  idea: Lightbulb,
  star: Star,
  megaphone: Megaphone,
  clock: Clock,
  redeem: TicketCheck,
  locate: LocateFixed,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Pixel size (square). Default 18. */
  size?: number;
  /** Stroke weight. Default 2 (Lucide's default). */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  /** Provide when the icon is meaningful on its own; omit to mark it decorative (aria-hidden). */
  "aria-label"?: string;
}

export function Icon({ name, size = 18, strokeWidth = 2, className, style, "aria-label": ariaLabel }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
      {...(ariaLabel ? { "aria-label": ariaLabel, role: "img" } : { "aria-hidden": true })}
    />
  );
}
