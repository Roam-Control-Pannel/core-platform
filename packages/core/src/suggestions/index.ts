/**
 * suggestions core — the template-based marketing suggestion generator (Phase 4, v1).
 *
 * Pure and deterministic: given a venue's marketing prefs (the cap it won't exceed, the offer
 * THEMES it likes, a note on what it discounts), its per-theme ENGAGEMENT so far, and a day-of-week
 * CONTEXT (passed in — core never reads the clock), it returns a ranked list of suggested offers
 * and posts the business can review, edit and publish. No AI here (that's the v2 that swaps the
 * templates for generated copy); no side effects, so it's trivially testable and cache-friendly.
 *
 * The generator NEVER exceeds the discount cap, always leaves the copy editable, and ranks offer
 * ideas by how much each theme has actually engaged locals (saves weighted, redemptions weighted
 * more) so the strongest ideas surface first.
 */
import { offerTypeLabel, normaliseOfferType } from "../offers/index.js";

export interface EngagementRow {
  offerType: string;
  saves: number;
  redemptions: number;
}

export interface SuggestionInput {
  discountCapPct: number | null;
  offerTypes: string[];
  productNotes: string | null;
  engagement: EngagementRow[];
  /** Day name in the venue's timezone, e.g. "Friday" — the API passes it (core can't read a clock). */
  dayName: string;
}

export interface Suggestion {
  id: string;
  kind: "offer" | "post";
  offerType: string | null;
  title: string;
  body: string;
  suggestedDiscountPct: number | null;
  rationale: string;
}

const DEFAULT_TYPES = ["percent_off", "two_for_one"];
const DEFAULT_CAP = 20;
const DEFAULT_PCT = 20;

/** Split the free-text "what do you discount" note into a few subjects. */
export function discountSubjects(notes: string | null | undefined): string[] {
  if (!notes) return [];
  return notes
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** The headline subject to feature in copy (first note, else a friendly generic). */
function featured(notes: string | null | undefined): string {
  return discountSubjects(notes)[0] ?? "a customer favourite";
}

/** Engagement weight for a theme: redemptions count more than saves; unknown → 0. */
function engagementScore(engagement: EngagementRow[], type: string): number {
  const row = engagement.find((e) => normaliseOfferType(e.offerType) === normaliseOfferType(type));
  return row ? row.saves * 2 + row.redemptions * 3 : 0;
}

type Template = (feat: string, pct: number) => { title: string; body: string };

const OFFER_TEMPLATES: Record<string, Template> = {
  percent_off: (f, pct) => ({ title: `${pct}% off ${f}`, body: `Take ${pct}% off ${f} — a gentle nudge for locals to give you a try.` }),
  amount_off: (f) => ({ title: `Money off ${f}`, body: `A set amount off ${f} when a customer shows the offer in-venue.` }),
  two_for_one: (f) => ({ title: `2-for-1 on ${f}`, body: `Buy one ${f}, get one free — great for bringing a friend along.` }),
  bogof: (f) => ({ title: `Buy one get one free — ${f}`, body: `Two ${f} for the price of one, for a limited time.` }),
  free_item: (f) => ({ title: `A free ${f}`, body: `Treat locals to a free ${f} with any purchase.` }),
  bundle: (f) => ({ title: `${f} bundle deal`, body: `Pair ${f} into a bundle at a friendlier price than buying separately.` }),
  happy_hour: (f) => ({ title: `Happy hour on ${f}`, body: `A set window each day with ${f} at a special price — perfect for quiet spells.` }),
  loyalty: (f) => ({ title: `Loyalty reward — ${f}`, body: `Reward your regulars with ${f} after a few visits.` }),
  first_time: (f) => ({ title: `First-timer offer on ${f}`, body: `A warm welcome — a ${f} deal just for new customers.` }),
  seasonal: (f) => ({ title: `Seasonal ${f} special`, body: `A limited seasonal deal on ${f} to match the moment.` }),
  other: (f) => ({ title: `Special on ${f}`, body: `An exclusive deal on ${f} for locals.` }),
};

/** A friendly lead for a day-of-week post nudge. */
function dayLead(dayName: string): string {
  const d = dayName.toLowerCase();
  if (d === "friday" || d === "saturday") return "The weekend's here";
  if (d === "sunday") return "A gentle Sunday";
  if (d === "monday") return "A fresh week";
  return "Midweek";
}

/**
 * Generate ranked, cap-respecting suggestions. Returns up to three offer ideas (the venue's
 * preferred themes, best-engaging first) plus two post ideas. Empty prefs fall back to sensible
 * defaults so a business that skipped the detail still gets useful starters.
 */
export function generateSuggestions(input: SuggestionInput): Suggestion[] {
  const feat = featured(input.productNotes);
  const cap = input.discountCapPct ?? DEFAULT_CAP;
  const pct = Math.min(cap, DEFAULT_PCT);

  const chosen = input.offerTypes.length > 0 ? input.offerTypes : DEFAULT_TYPES;
  // De-dup, then rank by engagement (desc), stable on the chosen order.
  const seen = new Set<string>();
  const unique = chosen.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  const ranked = unique
    .map((t, i) => ({ t, i, score: engagementScore(input.engagement, t) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.t);

  const offers: Suggestion[] = ranked.slice(0, 3).map((type) => {
    const tpl = OFFER_TEMPLATES[type] ?? OFFER_TEMPLATES["other"];
    const usesPct = type === "percent_off";
    const built = (tpl as Template)(feat, pct);
    const score = engagementScore(input.engagement, type);
    return {
      id: `offer:${type}`,
      kind: "offer" as const,
      offerType: type,
      title: built.title,
      body: built.body,
      suggestedDiscountPct: usesPct ? pct : null,
      rationale:
        score > 0
          ? `Your ${offerTypeLabel(type)} deals draw the most interest so far.`
          : `A proven way to bring new locals through the door.`,
    };
  });

  const posts: Suggestion[] = [
    {
      id: "post:whatson",
      kind: "post" as const,
      offerType: null,
      title: `${dayLead(input.dayName)} — tell locals what's on`,
      body: `A quick update on ${feat} and anything special you've got on. Keeps you fresh in your town's local feed.`,
      suggestedDiscountPct: null,
      rationale: "Regular posts keep you visible in the local news feed.",
    },
    {
      id: "post:nudge",
      kind: "post" as const,
      offerType: null,
      title: "A short nudge to your followers",
      body: `Let the people who follow you know about ${feat} today — a friendly reminder that lands as a notification.`,
      suggestedDiscountPct: null,
      rationale: "Followers who get a timely nudge are more likely to drop in.",
    },
  ];

  return [...offers, ...posts];
}
