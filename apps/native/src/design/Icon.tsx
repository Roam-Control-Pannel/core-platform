/**
 * Icon — the native half of @roam/design's icon surface.
 *
 * Same SEMANTIC vocabulary as web's Icon (`<Icon name="place" />`), same underlying set
 * (Lucide, via lucide-react-native instead of lucide-react), so the two surfaces draw the
 * SAME glyph for the same name — one place to swap the set, rename, or restyle. The name
 * map is kept in lockstep with packages/design/src/components/Icon.tsx; add names in both.
 *
 * One RN difference: there is no `currentColor`, so an RN icon can't inherit the
 * surrounding text colour the way the web one does. Colour is therefore an explicit prop,
 * defaulting to the ink token — callers pass the crimson/muted they'd otherwise inherit.
 */
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
  TrainFront,
  Bus,
  TramFront,
  Ship,
  EyeOff,
  Circle,
  CircleDot,
  GripVertical,
  BedDouble,
  Plane,
  Trees,
  Utensils,
  ShoppingBag,
  Tag,
  Share2,
  Link2,
  LayoutGrid,
  Briefcase,
  Church,
  CreditCard,
  House,
  type LucideIcon,
} from "lucide-react-native";
import { color } from "@roam/design/tokens";

/** Semantic name → Lucide icon. Mirrors the web map exactly; usage stays name-based. */
const ICONS = {
  home: House,
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
  train: TrainFront,
  bus: Bus,
  tram: TramFront,
  ferry: Ship,
  eyeOff: EyeOff,
  radioOn: CircleDot,
  radioOff: Circle,
  grip: GripVertical,
  hotel: BedDouble,
  flight: Plane,
  outdoor: Trees,
  dining: Utensils,
  bag: ShoppingBag,
  tag: Tag,
  share: Share2,
  link: Link2,
  widgets: LayoutGrid,
  briefcase: Briefcase,
  church: Church,
  card: CreditCard,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Pixel size (square). Default 18 — same default as web. */
  size?: number;
  /** Stroke weight. Default 2 (Lucide's default). */
  strokeWidth?: number;
  /** Explicit colour (no currentColor in RN). Defaults to the ink token. */
  color?: string;
}

export function Icon({ name, size = 18, strokeWidth = 2, color: tint = color.ink }: IconProps) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={strokeWidth} color={tint} />;
}
