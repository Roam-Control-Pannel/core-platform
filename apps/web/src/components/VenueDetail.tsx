/**
 * VenueDetail — the full-page venue surface, now with the FIRST real write-path on
 * the consumer surface: claim-as-request + just-in-time auth.
 *
 * States (mirroring VenueCard's split, at full-page depth, plus the claim machinery):
 *
 *  - CLAIMED (owner_id set): hero, name, ★rating (gold) + category, description,
 *    Links row, Details. Degrades gracefully when fields are null.
 *  - UNCLAIMED (owner_id null, status 'unclaimed'): the global-launch median
 *    experience — honest provenance, locality context, and the claim entry point as
 *    the page's single primary CTA. NO rating (over-claiming on scraped data is
 *    forbidden). This is where claiming begins.
 *  - PENDING CLAIM (status 'pending_claim'): someone has already requested this venue
 *    and it's awaiting verification. NOT claimable again here — we show an honest
 *    "under review" state instead of a second competing CTA.
 *
 * THE CLAIM FLOW (claim-as-request — see 0006_venue_claims.sql):
 * Claiming is a trust event, not a land-grab. Pressing "Claim" does NOT set ownership;
 * it submits a REQUEST that moves the venue unclaimed → pending_claim and records a
 * claim awaiting verification. Ownership is conferred only later by the service-role
 * approval path.
 *
 *   signed in  → press Claim → venues.requestClaim → "claim submitted, under review"
 *   signed out → press Claim → AuthPanel appears (JIT auth):
 *       • sign IN  → session immediate → claim submits in the same sitting
 *       • sign UP  → email confirmation (project default ON) → no session yet →
 *                    "check your email"; the confirmation link returns here with
 *                    ?claim=1, and on return — now signed in — the claim auto-resumes.
 *
 * All four base states still ship with the screen (States matrix): loading
 * (content-shaped skeleton), error, not-found, and the loaded states.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { selectHero, galleryOrder, type PhotoRow } from "../lib/venuePhotos";
import { OfferCard, type ConsumerOffer } from "./OfferCard";
import Link from "next/link";
import { Card, Pill, Rate, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { FollowButton } from "./FollowButton";
import { ReportVenue } from "./ReportVenue";
import { AddToPlan } from "./AddToPlan";
import { CopyLinkButton } from "./CopyLinkButton";
import { VenueShop } from "./VenueShop";
import { isOpenNow } from "../lib/openNow";
import { getFormatLocale } from "../lib/i18n/runtime";
import { directionsUrl, detectMapsPlatform } from "../lib/directions";
import { effectiveRating, ROAM_RATING_MIN } from "../lib/rating";
import { VenueMap } from "./VenueMap";
import styles from "./VenueDetail.module.css";

/**
 * The byId result is the full venues Row (select("*")). We read it loosely here —
 * the fields we render are a stable subset; `geo` (PostGIS `unknown`) is never touched
 * client-side (proximity is the RPC's job, not this page's).
 */
export interface VenueDetailData {
  id: string;
  name: string;
  owner_id: string | null;
  status: string;
  category: string | null;
  categories: string[];
  rating: number | null;
  rating_count: number;
  description: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  opening_times: {
    weekdayDescriptions?: string[];
    periods?: { day: number; closed: boolean; intervals: { open: string; close: string }[] }[];
    timezone?: string;
    source?: string;
  } | null;
  links: Record<string, unknown> | null;
  source_attribution: string | null;
  /** Provenance: "google_places" for a Places-sourced venue, "owner" once claimed, etc.
   *  Gates on-demand enrichment (only unclaimed Places venues are enriched). */
  source?: string | null;
  /** The venue's Places id — the deep-link key for "Write a Google review" (no API cost). */
  source_ref?: string | null;
  /* Rich Places facts (0065) — absent until the migration + enrichment have run, so every
     read below is defensive: missing/undefined just hides the section. */
  phone?: string | null;
  website_url?: string | null;
  price_range?: { start: number | null; end: number | null; currency: string | null } | null;
  attributes?: Record<string, boolean | Record<string, boolean>> | null;
  /** When the on-demand Places Details enrichment last ran (0080). null/undefined => never
   *  enriched, so the client fires one /api/enrich-venue call to fill the rich facts in. */
  details_fetched_at?: string | null;
  /** Roam's own rollup (0085) — our reviews' average + count, for the effective-rating logic. */
  roam_rating?: number | null;
  roam_rating_count?: number | null;
  /** Coordinates, generated from geo (0086) — for the "Where to find it" map. */
  lat?: number | null;
  lng?: number | null;
}

/** Where the claim CTA currently stands, locally. Drives which affordance shows. */
type ClaimUiState =
  | "idle" // not started
  | "auth" // signed out, AuthPanel showing
  | "submitting" // requestClaim in flight
  | "submitted" // success — under review
  | "error"; // requestClaim failed (message in claimError)

/** Venue ids already counted as viewed this page lifetime (guards SPA re-mount recounts). */
const viewedVenues = new Set<string>();

/** Venue ids we've already fired an on-demand enrichment for this page lifetime (one attempt
 *  each — the server is idempotent via details_fetched_at, this just avoids redundant POSTs). */
const enrichAttempted = new Set<string>();

export function VenueDetail({ venueId, initialVenue }: { venueId: string; initialVenue?: VenueDetailData | null }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  const session = useSession();
  const [venue, setVenue] = useState<VenueDetailData | null | undefined>(initialVenue);
  const [error, setError] = useState<string | null>(null);

  const [claimUi, setClaimUi] = useState<ClaimUiState>("idle");
  const [claimError, setClaimError] = useState<string | null>(null);

  // Follow state for THIS venue, read once after load from the caller's myFollows.
  // undefined = not yet known (button renders its default-off until this resolves);
  // a claimed venue is the only state that shows a FollowButton (see ClaimedDetail).
  const [following, setFollowing] = useState<boolean | undefined>(undefined);

  const loadVenue = useCallback(async () => {
    // The byId procedure returns the full generated `venues` Row (select("*")), a
    // deeply-nested type (Json fields, enum refs). Inferring it through the tRPC
    // client's promise chain trips TS2589 (instantiation too deep), so we widen the
    // call to a minimal query signature here — runtime unchanged, narrow back below.
    const byId = trpc.venues.byId as unknown as {
      query: (input: { venueId: string }) => Promise<unknown>;
    };
    try {
      const row = await byId.query({ venueId });
      return (row as VenueDetailData | null) ?? null;
    } catch (e: unknown) {
      throw e instanceof Error ? e : new Error(t("errors.loadFailed"));
    }
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    // When the server seeded the venue (SSR), refresh silently so the already-rendered content
    // stays put; only the unseeded path shows the skeleton and surfaces a load error.
    const seeded = initialVenue !== undefined;
    if (!seeded) {
      setVenue(undefined);
      setError(null);
    }
    loadVenue()
      .then((v) => {
        if (cancelled) return;
        setVenue((cur) => {
          // A silent refresh must not clobber enrichment we merged locally moments ago: this
          // read is anonymous/cached and may have been issued BEFORE the enrichment write
          // committed, so if the current row is already enriched and the fresh read isn't,
          // keep ours. (The enrichment effect below is the source of truth for those fields.)
          if (cur && v && cur.id === v.id && cur.details_fetched_at && !v.details_fetched_at) return cur;
          return v;
        });
      })
      .catch((e: unknown) => {
        if (!cancelled && !seeded) setError(e instanceof Error ? e.message : t("errors.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [loadVenue, initialVenue]);

  // Count a profile view for the owner's dashboard — fire-and-forget, once per venue per
  // page lifetime (the module-level set survives client-side nav re-mounts, so back-and-forth
  // browsing doesn't inflate the counter). No viewer identity is ever sent or stored.
  useEffect(() => {
    if (viewedVenues.has(venueId)) return;
    viewedVenues.add(venueId);
    const rec = trpc.venues.recordView as unknown as {
      mutate: (i: { venueId: string }) => Promise<{ ok: boolean }>;
    };
    rec.mutate({ venueId }).catch(() => {
      /* an uncounted view, nothing more */
    });
  }, [trpc, venueId]);

  // On-demand ENRICHMENT: the first time an unclaimed, Places-sourced venue that has never been
  // enriched is opened, pull its rich Places Details facts (phone/website/price range/amenities)
  // once and merge them in so the "Good to know" + contact rows appear without a reload. One
  // attempt per venue per page lifetime; the server is idempotent (details_fetched_at) and the
  // Details call is budget-capped. Best-effort — a failure just leaves the lean profile.
  // Gate on PRIMITIVES, not the whole `venue` object: the silent refresh above replaces `venue`
  // with a fresh (same-id, still-un-enriched) row, and keying this effect on the object would
  // tear down the in-flight enrichment before its slow Places call returns — losing the merge.
  // Same id + still un-enriched => same deps => this effect (and its POST) is left untouched.
  const enrichId = venue?.id ?? null;
  const enrichSource = venue?.source ?? null;
  const enrichOwnerId = venue?.owner_id ?? null;
  const enrichFetchedAt = venue?.details_fetched_at ?? null;
  useEffect(() => {
    if (!enrichId || enrichSource !== "google_places" || enrichOwnerId !== null || enrichFetchedAt) return;
    if (enrichAttempted.has(enrichId)) return;
    enrichAttempted.add(enrichId);
    const targetId = enrichId;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/enrich-venue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ venueId: targetId }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          enriched?: boolean;
          fields?: {
            phone: string | null;
            website_url: string | null;
            price_range: { start: number | null; end: number | null; currency: string | null } | null;
            attributes: Record<string, boolean | Record<string, boolean>> | null;
          } | null;
        };
        if (cancelled || !data.enriched || !data.fields) return;
        const fields = data.fields;
        setVenue((cur) =>
          cur && cur.id === targetId
            ? { ...cur, ...fields, details_fetched_at: new Date().toISOString() }
            : cur,
        );
      } catch {
        /* enrichment is best-effort; a failure leaves the lean profile untouched */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrichId, enrichSource, enrichOwnerId, enrichFetchedAt]);

  // Read whether the caller already follows this venue. Signed-out → not following.
  // We load the full myFollows set and check membership: one extra query on a detail
  // page is fine, and reuses the query the Following view will use. The grid path
  // (3b) will instead pass a precomputed followingSet so N cards don't each fetch.
  // Gate on the user IDENTITY, not the session object: Supabase emits a fresh Session
  // reference on every TOKEN_REFRESHED / focus event, so depending on `session` would
  // refetch myFollows on benign token churn — the query storm Following.tsx documents and
  // guards the same way. The user id is stable across refreshes.
  const followUserId = session?.user?.id ?? null;
  useEffect(() => {
    if (!followUserId) {
      setFollowing(false);
      return;
    }
    let cancelled = false;
    const myFollows = trpc.social.myFollows as unknown as {
      query: () => Promise<{ ok: boolean; follows?: { venue_id: string }[] }>;
    };
    myFollows
      .query()
      .then((res) => {
        if (cancelled) return;
        const set = res.ok ? (res.follows ?? []) : [];
        setFollowing(set.some((f) => f.venue_id === venueId));
      })
      .catch(() => {
        if (!cancelled) setFollowing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, followUserId, venueId]);

  /**
   * Submit the claim request. Assumes a session exists (caller gates on it). On
   * success we move the local UI to "submitted" and refresh the venue so its status
   * reflects pending_claim from the server (single source of truth).
   */
  const submitClaim = useCallback(async () => {
    setClaimUi("submitting");
    setClaimError(null);
    try {
      await trpc.venues.requestClaim.mutate({ venueId });
      setClaimUi("submitted");
      // Re-read so the venue's status (now pending_claim) is server-truth, not assumed.
      const fresh = await loadVenue();
      setVenue(fresh);
    } catch (e: unknown) {
      setClaimError(e instanceof Error ? e.message : t("errors.claimFailed"));
      setClaimUi("error");
    }
  }, [trpc, venueId, loadVenue]);

  /**
   * Resume-after-confirmation: if the page was opened with ?claim=1 (the redirect
   * target the AuthPanel set on sign-up) AND we now have a session, auto-fire the
   * claim once. The flag is cleared from the URL so a refresh doesn't re-fire.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("claim") !== "1") return;
    if (!session) return; // wait for the session to land post-confirmation
    if (claimUi !== "idle" && claimUi !== "auth") return;

    // Clear the flag so a manual refresh won't resubmit.
    params.delete("claim");
    const cleaned =
      window.location.pathname + (params.toString() ? `?${params}` : "");
    window.history.replaceState(null, "", cleaned);

    void submitClaim();
  }, [session, claimUi, submitClaim]);

  /** Claim button pressed. Signed in → submit; signed out → show the auth panel. */
  const onClaimPressed = useCallback(() => {
    if (session) {
      void submitClaim();
    } else {
      setClaimUi("auth");
    }
  }, [session, submitClaim]);

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <BackLink />
      {error ? (
        <ErrorState message={error} />
      ) : venue === undefined ? (
        <DetailSkeleton />
      ) : venue === null ? (
        <NotFoundState />
      ) : venue.owner_id !== null ? (
        <ClaimedDetail
          venue={venue}
          venueId={venueId}
          initialFollowing={following ?? false}
          isOwner={session?.user?.id === venue.owner_id}
        />
      ) : venue.status === "pending_claim" ? (
        <PendingClaimDetail venue={venue} venueId={venueId} mineJustSubmitted={claimUi === "submitted"} />
      ) : (
        <UnclaimedDetail
          venue={venue}
          claimUi={claimUi}
          claimError={claimError}
          onClaimPressed={onClaimPressed}
          onAuthed={submitClaim}
          venueId={venueId}
        />
      )}

      {/* Quiet report affordance — the user-facing half of the moderation backstop. Shown on
          any real venue (not the loading / not-found / error states). */}
      {venue ? <ReportVenue venueId={venueId} /> : null}
    </main>
  );
}

function BackLink() {
  const t = useTranslations("venueDetail");
  return (
    <Link
      href="/explore"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        color: "var(--muted)",
        textDecoration: "none",
        marginBottom: "var(--space-4)",
      }}
    >
      <span aria-hidden>←</span> {t("back")}
    </Link>
  );
}

/**
 * VenuePhotos — the photo surface for a venue: a hero (replacing the CSS-gradient
 * placeholder when photos exist) plus a gallery strip. Fetches the venue's photo rows
 * ONCE via venues.photosByVenue, then derives the hero (selectHero) and ordered gallery
 * (galleryOrder) from @roam/core/photos. Falls back to the gradient Hero when there are
 * no photos — the honest empty state (unclaimed venues Google had no photos for, or a
 * claimed venue whose owner has not uploaded yet).
 *
 * Photos are venue FACTS, shown in every loaded state regardless of claim (same
 * principle as opening hours): owner content outranks scraped, both render here.
 */
function VenuePhotos({ venueId, claimed }: { venueId: string; claimed: boolean }) {
  const trpc = useTrpc();
  const [rows, setRows] = useState<PhotoRow[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const photosByVenue = trpc.venues.photosByVenue as unknown as {
      query: (input: { venueId: string }) => Promise<PhotoRow[]>;
    };
    photosByVenue
      .query({ venueId })
      .then((res) => {
        if (!cancelled) setRows(Array.isArray(res) ? res : []);
      })
      .catch(() => {
        if (!cancelled) setRows([]); // a photo-load failure must not break the page
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  // Until loaded, or when there are no photos, show the existing gradient Hero — the
  // page never waits on photos and degrades to exactly today's look.
  if (rows === undefined || rows.length === 0) {
    return <Hero claimed={claimed} />;
  }

  const hero = selectHero(rows);
  const gallery = galleryOrder(rows);

  return (
    <>
      {hero ? (
        <div style={{ borderRadius: 16, overflow: "hidden", marginBottom: "var(--space-4)" }}>
          <VenuePhoto photoId={hero.id} alt="" heightPx={220} />
        </div>
      ) : (
        <Hero claimed={claimed} />
      )}
      {gallery.length > 1 ? (
        <div
          style={{
            display: "flex",
            gap: "var(--space-2)",
            overflowX: "auto",
            marginBottom: "var(--space-4)",
            paddingBottom: 4,
          }}
        >
          {gallery
            .filter((p: PhotoRow) => p.id !== hero?.id)
            .map((p: PhotoRow) => (
              <div
                key={p.id}
                style={{ flex: "0 0 auto", width: 120, borderRadius: 12, overflow: "hidden" }}
              >
                <VenuePhoto photoId={p.id} alt="" heightPx={90} />
              </div>
            ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * VenuePhoto — resolves ONE photo to a renderable url via venues.photoMediaUrl (public;
 * the API holds the Google key and returns a short-lived, keyless googleusercontent url)
 * and renders it. Resolves lazily on mount, so only photos actually shown are resolved.
 * On a resolve failure it renders nothing — never a broken image.
 */
function VenuePhoto({
  photoId,
  alt,
  heightPx,
}: {
  photoId: string;
  alt: string;
  heightPx: number;
}) {
  const trpc = useTrpc();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const photoMediaUrl = trpc.venues.photoMediaUrl as unknown as {
      query: (input: { photoId: string }) => Promise<{ url: string }>;
    };
    photoMediaUrl
      .query({ photoId })
      .then((res) => {
        if (!cancelled) setUrl(res?.url ?? null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, photoId]);

  if (!url) {
    // Reserve the space (no layout shift) with a neutral placeholder while resolving.
    return <div style={{ height: heightPx, background: "var(--crimson-tint)" }} />;
  }
  return (
    // A plain <img> is correct here: src is a short-lived, keyless googleusercontent URL
    // resolved fresh on mount (~1hr TTL). next/image would optimize/cache a URL that
    // expires and cannot be re-resolved by the optimizer, so we opt out deliberately.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      loading="lazy"
      style={{ display: "block", width: "100%", height: heightPx, objectFit: "cover" }}
    />
  );
}

function Hero({ claimed }: { claimed: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        height: 200,
        borderRadius: 16,
        marginBottom: "var(--space-4)",
        ...(claimed
          ? {
              background:
                "radial-gradient(120% 90% at 20% 10%, #e7b48a 0%, transparent 55%)," +
                "radial-gradient(120% 120% at 90% 90%, #7c3a2a 0%, transparent 60%)," +
                "linear-gradient(150deg, #c96b43, #8f3f29)",
            }
          : {
              // Calm "locality tile" (design): a soft warm gradient, not a dashed
              // placeholder — an intentional stand-in when there's no photo.
              background: "linear-gradient(135deg, var(--crimson-tint), var(--paper-2))",
              display: "grid",
              placeItems: "center",
            }),
      }}
    >
      {claimed ? null : (
        <Icon name="place" size={40} style={{ color: "var(--crimson-700)", opacity: 0.5 }} />
      )}
    </div>
  );
}

function TitleRow({ name }: { name: string }) {
  return (
    <h1
      className="t-h1"
      style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, letterSpacing: "-.02em", margin: 0 }}
    >
      {name}
    </h1>
  );
}

/**
 * The claimed venue content tabs. "Details" is the only real tab today (description, hours,
 * the facts block); Posts · Offers · Shop are dormant seams (Stage-2 surfaces) — visible so
 * the structure reads as designed, but faint and inert until those features ship.
 */
type VenueTab = "posts" | "offers" | "gallery" | "details" | "shop";

function ClaimedDetail({
  venue,
  venueId,
  initialFollowing,
  isOwner,
}: {
  venue: VenueDetailData;
  venueId: string;
  initialFollowing: boolean;
  isOwner: boolean;
}) {
  const t = useTranslations("venueDetail");
  const links = linkEntries(venue.links);
  // Posts · Offers · Gallery · Details are live (data already exists); Shop is the one
  // remaining Stage-5 seam. Details leads — it always has something to show.
  // Initial tab honours a ?tab= deep link (e.g. the Market's product cards land on the
  // Shop tab); anything unrecognised falls back to Details. Read once at mount — the tab
  // is client state after that, not URL state.
  const [tab, setTab] = useState<VenueTab>(() => {
    if (typeof window === "undefined") return "details";
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return wanted === "posts" || wanted === "offers" || wanted === "gallery" || wanted === "shop" ? wanted : "details";
  });

  return (
    <>
      <VenuePhotos venueId={venueId} claimed />
      <div className={styles.layout}>
        {/* Sticky info/action column on web; the first block on mobile. */}
        <aside className={styles.aside}>
          <TitleRow name={venue.name} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              marginTop: "var(--space-2)",
              fontSize: 13.5,
              color: "var(--ink-2)",
            }}
          >
            {/* Claimed shows ★rating (gold) — the sanctioned confidence signal on a verified venue. */}
            {venue.rating != null ? (
              <Rate value={`${venue.rating.toFixed(1)}${venue.rating_count ? ` (${venue.rating_count})` : ""}`} />
            ) : null}
            {venue.category ? <span>{venue.category}</span> : null}
          </div>

          {isOwner ? (
            <Link
              href={`/dashboard/${venueId}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: "var(--space-3)",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--crimson-700)",
                textDecoration: "none",
              }}
            >
              {t("manageVenue")} <span aria-hidden>→</span>
            </Link>
          ) : null}

          <VenueActions venueId={venueId} name={venue.name} initialFollowing={initialFollowing} address={venue.address} />

          {links.length > 0 ? (
            <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
              {links.map(([label, url]) => (
                <a key={label} href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                  <Pill variant="crim">{capitalise(label)}</Pill>
                </a>
              ))}
            </div>
          ) : null}
        </aside>

        {/* Scrolling tabbed content column on web. */}
        <div className={styles.content}>
          {/* Tab order mirrors the venue design (Posts · Offers · Gallery · Details · Shop) —
              all live now that the marketplace catalogue exists. */}
          <div className={styles.tabstrip} role="tablist" aria-label={t("tabsAria")}>
            <TabButton label={t("tabs.posts")} value="posts" active={tab} onSelect={setTab} />
            <TabButton label={t("tabs.offers")} value="offers" active={tab} onSelect={setTab} />
            <TabButton label={t("tabs.gallery")} value="gallery" active={tab} onSelect={setTab} />
            <TabButton label={t("tabs.details")} value="details" active={tab} onSelect={setTab} />
            <TabButton label={t("tabs.shop")} value="shop" active={tab} onSelect={setTab} />
          </div>

          {tab === "details" ? (
            <>
              {venue.description ? (
                <p style={{ marginTop: 0, lineHeight: 1.6, color: "var(--ink-2)" }}>{venue.description}</p>
              ) : null}
              <OpeningHours openingTimes={venue.opening_times} />
              <DetailsBlock venue={venue} />
            </>
          ) : tab === "posts" ? (
            <VenuePostsPanel venueId={venueId} />
          ) : tab === "offers" ? (
            <VenueOffersPanel venueId={venueId} />
          ) : tab === "gallery" ? (
            <VenueGalleryPanel venueId={venueId} />
          ) : tab === "shop" ? (
            <VenueShop venueId={venueId} />
          ) : null}
        </div>
      </div>

      <VenueReviews venueId={venueId} placeId={venue.source === "google_places" ? venue.source_ref ?? null : null} />
    </>
  );
}

/** A live, selectable tab. */
function TabButton({
  label,
  value,
  active,
  onSelect,
}: {
  label: string;
  value: VenueTab;
  active: VenueTab;
  onSelect: (v: VenueTab) => void;
}) {
  const on = active === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={on ? `${styles.tab} ${styles.tabActive}` : styles.tab}
      onClick={() => onSelect(value)}
    >
      {label}
    </button>
  );
}

/** Shared empty/loading note for the tab panels. */
const panelNote = { color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5, margin: "var(--space-3) 0 0" };

/** A short "12 Jun" date — tolerant of an unparseable value. */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(getFormatLocale(), { day: "numeric", month: "short" });
}

/** A venue's published posts (Posts tab). Each row links to the post-detail screen. */
function VenuePostsPanel({ venueId }: { venueId: string }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  type PostRow = { id: string; kind: string; title: string | null; body: string | null; media: { type: "image"; url: string }[]; publishedAt: string | null };
  const [posts, setPosts] = useState<PostRow[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const byVenue = trpc.posts.byVenue as unknown as {
      query: (i: { venueId: string }) => Promise<PostRow[]>;
    };
    byVenue
      .query({ venueId })
      .then((rows) => {
        if (!cancelled) setPosts(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setPosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  if (posts === undefined) return <PanelSkeleton />;
  if (posts.length === 0) return <p style={panelNote}>{t("posts.empty")}</p>;
  return (
    <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-1)" }}>
      {posts.map((p) => (
        <Link key={p.id} href={`/feed/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Card flat style={{ padding: 0, overflow: "hidden" }}>
            {p.media && p.media.length > 0 ? (
              // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
              <img src={p.media[0]!.url} alt="" loading="lazy" style={{ width: "100%", height: 168, objectFit: "cover", display: "block", background: "var(--paper-2)" }} />
            ) : null}
            <div style={{ padding: "var(--space-4)" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: p.kind === "offer" ? "var(--crimson-700)" : "var(--muted)" }}>
                {p.kind}
                {p.publishedAt ? <span style={{ color: "var(--faint)", fontWeight: 400 }}> · {shortDate(p.publishedAt)}</span> : null}
              </div>
              {p.title ? <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, marginTop: 4 }}>{p.title}</div> : null}
              {p.body ? (
                <p style={{ margin: "2px 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {p.body}
                </p>
              ) : null}
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

/** A venue's live offers (Offers tab) — each savable + redeemable in-venue. */
function VenueOffersPanel({ venueId }: { venueId: string }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  const [offers, setOffers] = useState<ConsumerOffer[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const forVenue = trpc.offers.forVenue as unknown as { query: (i: { venueId: string }) => Promise<ConsumerOffer[]> };
    forVenue
      .query({ venueId })
      .then((rows) => {
        if (!cancelled) setOffers(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setOffers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  if (offers === undefined) return <PanelSkeleton />;
  if (offers.length === 0) return <p style={panelNote}>{t("offers.empty")}</p>;
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
      {offers.map((o) => (
        <OfferCard key={o.id} offer={o} />
      ))}
    </div>
  );
}

/** A venue's full photo set (Gallery tab) — a responsive grid. */
function VenueGalleryPanel({ venueId }: { venueId: string }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  const [rows, setRows] = useState<PhotoRow[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const photosByVenue = trpc.venues.photosByVenue as unknown as {
      query: (i: { venueId: string }) => Promise<PhotoRow[]>;
    };
    photosByVenue
      .query({ venueId })
      .then((res) => {
        if (!cancelled) setRows(Array.isArray(res) ? res : []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  if (rows === undefined) return <PanelSkeleton />;
  const gallery = galleryOrder(rows);
  if (gallery.length === 0) return <p style={panelNote}>{t("gallery.empty")}</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
      {gallery.map((p) => (
        <div key={p.id} style={{ borderRadius: 12, overflow: "hidden" }}>
          <VenuePhoto photoId={p.id} alt="" heightPx={120} />
        </div>
      ))}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
      <div style={{ height: 64, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      <div style={{ height: 64, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
    </div>
  );
}

/**
 * The claimed-venue action cluster (venue design): Follow · ＋Add to Plan · Get Directions,
 * STACKED full-width in the sticky aside (matching the design's left action column). Follow is
 * the live primary; Add to Plan is a dormant Stage-2 (Social) seam; Directions hands off to the
 * device maps app.
 */
function VenueActions({
  venueId,
  name,
  initialFollowing,
  address,
}: {
  venueId: string;
  name: string;
  initialFollowing: boolean;
  address: string | null;
}) {
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
      <FollowButton
        venueId={venueId}
        initialFollowing={initialFollowing}
        emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
      />
      <AddToPlan venueId={venueId} block />
      <DirectionsButton address={address} block />
      {/* Shares the current canonical /venue/<slug> URL (the page redirects UUID → slug). */}
      <CopyLinkButton variant="button" block title={name} />
    </div>
  );
}

function UnclaimedDetail({
  venue,
  claimUi,
  claimError,
  onClaimPressed,
  onAuthed,
  venueId,
}: {
  venue: VenueDetailData;
  claimUi: ClaimUiState;
  claimError: string | null;
  onClaimPressed: () => void;
  onAuthed: () => void;
  venueId: string;
}) {
  const claiming = claimUi !== "idle";
  return (
    <VenueProfileShell
      venue={venue}
      venueId={venueId}
      // Claim entry: the pink banner when idle; the live claim flow (auth / submitting /
      // confirmation) once pressed.
      topEntry={
        claiming ? (
          <div style={{ marginTop: "var(--space-4)" }}>
            <ClaimSection venueId={venueId} claimUi={claimUi} claimError={claimError} onClaimPressed={onClaimPressed} onAuthed={onAuthed} />
          </div>
        ) : (
          <ClaimBanner onClaimPressed={onClaimPressed} />
        )
      }
      sidebarEntry={claiming ? null : <ClaimCard onClaimPressed={onClaimPressed} />}
    />
  );
}

/**
 * The shared venue-profile layout (Discovery redesign): a full-width hero (photo + kicker, title,
 * status/locality/price/new chips) and a claim entry, then a main column (Good to know · Where to
 * find it · Reviews) beside a sticky sidebar (price + Add to Plan + Directions/Share + hours +
 * contact · the Google rating · a claim card). Unclaimed & pending states share it; they differ
 * only in the claim entry passed in.
 */
function VenueProfileShell({
  venue,
  venueId,
  topEntry,
  sidebarEntry,
}: {
  venue: VenueDetailData;
  venueId: string;
  topEntry: React.ReactNode;
  sidebarEntry: React.ReactNode;
}) {
  return (
    <>
      <VenueHero venue={venue} venueId={venueId} />
      {topEntry}
      <div className={styles.profileGrid}>
        <div className={styles.profileMain}>
          <GoodToKnow venue={venue} unclaimed />
          <WhereToFind venue={venue} />
          <div id="reviews">
            <VenueReviews
              venueId={venueId}
              placeId={venue.source === "google_places" ? venue.source_ref ?? null : null}
              venueName={venue.name}
            />
          </div>
        </div>
        <aside className={styles.sidebar}>
          <InfoSidebar venue={venue} venueId={venueId} />
          <RatingCard venueId={venueId} />
          {sidebarEntry}
        </aside>
      </div>
    </>
  );
}

/** The hero: the venue's best photo (or a warm gradient) under a dark scrim, with a back button,
 *  a "see all N photos" affordance, and the kicker / title / status chips overlaid. */
function VenueHero({ venue, venueId }: { venue: VenueDetailData; venueId: string }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  const [rows, setRows] = useState<PhotoRow[] | undefined>(undefined);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.venues.photosByVenue as unknown as { query: (i: { venueId: string }) => Promise<PhotoRow[]> };
    q.query({ venueId })
      .then((res) => { if (!cancelled) setRows(Array.isArray(res) ? res : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  const hero = rows ? selectHero(rows) : null;
  const heroId = hero?.id ?? null;
  const gallery = rows ? galleryOrder(rows).filter((p) => p.id !== heroId) : [];

  useEffect(() => {
    if (!heroId) { setHeroUrl(null); return; }
    let cancelled = false;
    const q = trpc.venues.photoMediaUrl as unknown as { query: (i: { photoId: string }) => Promise<{ url: string }> };
    q.query({ photoId: heroId })
      .then((r) => { if (!cancelled) setHeroUrl(r?.url ?? null); })
      .catch(() => { if (!cancelled) setHeroUrl(null); });
    return () => { cancelled = true; };
  }, [trpc, heroId]);

  const photoCount = rows?.length ?? 0;

  return (
    <>
      <div className={styles.hero}>
        {heroUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived googleusercontent URL
          <img className={styles.heroImg} src={heroUrl} alt="" />
        ) : null}
        <div className={styles.heroScrim} aria-hidden />
        <Link href="/explore" aria-label={t("back")} className={`${styles.heroBtn} ${styles.heroBack}`}>
          <span aria-hidden>←</span>
        </Link>
        {gallery.length > 0 ? (
          <button
            type="button"
            className={`${styles.heroBtn} ${styles.heroPhotos}`}
            onClick={() => document.getElementById("venue-thumbs")?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
          >
            {t("seeAllPhotos", { count: photoCount })}
          </button>
        ) : null}
        <div className={styles.heroBody}>
          {venue.category ? <div className={styles.heroKicker}>{venue.category}</div> : null}
          <h1 className={styles.heroTitle}>{venue.name}</h1>
          <HeroChips venue={venue} />
        </div>
      </div>
      {gallery.length > 0 ? (
        <div id="venue-thumbs" className={styles.thumbs}>
          {gallery.map((p) => (
            <div key={p.id} className={styles.thumb}>
              <VenuePhoto photoId={p.id} alt="" heightPx={70} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** The status/locality/price/new chips over the hero. */
function HeroChips({ venue }: { venue: VenueDetailData }) {
  const t = useTranslations("venueDetail");
  const open = venue.opening_times ? isOpenNow(venue.opening_times, new Date()) : null;
  const price = venue.price_range ? priceRangeLabel(t, venue.price_range) : null;

  const base: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600,
    padding: "5px 11px", borderRadius: 999, background: "rgba(255,255,255,.16)", color: "#fff",
    backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
  };
  const chips: React.ReactNode[] = [];
  if (open && open.status === "open") {
    chips.push(<span key="open" style={{ ...base, background: "rgba(43,150,80,.92)" }}>● {open.nextChange ? t("hours.openNowCloses", { time: open.nextChange.at }) : t("hours.openNow")}</span>);
  } else if (open && open.status === "closed") {
    chips.push(<span key="closed" style={base}>● {open.nextChange ? t("hours.closedOpens", { time: open.nextChange.at }) : t("hours.closed")}</span>);
  }
  if (venue.locality) chips.push(<span key="loc" style={base}>◍ {venue.locality}</span>);
  if (price) chips.push(<span key="price" style={base}>{price}{t("goodToKnow.perPersonShort")}</span>);
  chips.push(<span key="new" style={{ ...base, background: "rgba(230,168,85,.95)", color: "#3a2408" }}>{t("newToRoam")}</span>);

  return <div className={styles.heroChips}>{chips}</div>;
}

/** The pink "is this your business?" claim banner shown above the fold. */
function ClaimBanner({ onClaimPressed }: { onClaimPressed: () => void }) {
  const t = useTranslations("venueDetail");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-4)", padding: "var(--space-3) var(--space-4)", borderRadius: 16, background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint)", flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flex: 1, minWidth: 220 }}>
        <span aria-hidden style={{ width: 34, height: 34, borderRadius: 10, background: "var(--crimson)", color: "#fff", display: "grid", placeItems: "center", flexShrink: 0 }}>
          <Icon name="shop" size={17} />
        </span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{t("claim.bannerTitle")}</div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>{t("claim.bannerBody")}</div>
        </div>
      </div>
      <Button variant="pri" size="sm" onClick={onClaimPressed}>{t("claim.claimThis")}</Button>
    </div>
  );
}

/** The sticky sidebar: price, primary actions, hours, and contact. */
function InfoSidebar({ venue, venueId }: { venue: VenueDetailData; venueId: string }) {
  const t = useTranslations("venueDetail");
  const price = venue.price_range ? priceRangeLabel(t, venue.price_range) : null;
  let host: string | null = null;
  if (venue.website_url) {
    try { host = new URL(venue.website_url).hostname.replace(/^www\./, ""); } catch { host = venue.website_url; }
  }
  const divider = <div style={{ height: 1, background: "var(--line)", margin: "var(--space-1) 0" }} />;

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: "var(--space-4)", background: "var(--paper)" }}>
      {price ? (
        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 20, marginBottom: "var(--space-3)" }}>
          {price} <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 400, fontFamily: "var(--ui)" }}>{t("goodToKnow.perPerson")}</span>
        </div>
      ) : null}
      <AddToPlan venueId={venueId} block />
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <div style={{ flex: 1 }}><DirectionsButton address={venue.address} block /></div>
        <div style={{ flex: 1 }}><CopyLinkButton variant="button" size="md" title={venue.name} block /></div>
      </div>

      <OpenHoursRow openingTimes={venue.opening_times} />

      {venue.phone ? (
        <>
          {divider}
          <div style={{ padding: "8px 0" }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{t("details.phone")}</div>
            <a href={`tel:${venue.phone.replace(/\s+/g, "")}`} style={{ fontSize: 14, color: "var(--ink)", textDecoration: "none", fontWeight: 600 }}>{venue.phone}</a>
          </div>
        </>
      ) : null}
      {host ? (
        <>
          {divider}
          <div style={{ padding: "8px 0" }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{t("details.website")}</div>
            <a href={venue.website_url!} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: 14, color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>{host} ↗</a>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Open-now status + an expandable weekday list (from the structured or Places hours). */
function OpenHoursRow({ openingTimes }: { openingTimes: VenueDetailData["opening_times"] }) {
  const t = useTranslations("venueDetail");
  const [open, setOpen] = useState(false);
  const days = (openingTimes?.weekdayDescriptions ?? []).filter((d): d is string => typeof d === "string" && d.length > 0);
  const now = openingTimes ? isOpenNow(openingTimes, new Date()) : null;
  if (days.length === 0 && !now) return null;

  const label =
    now && now.status === "open"
      ? now.nextChange ? t("hours.openNowCloses", { time: now.nextChange.at }) : t("hours.openNow")
      : now && now.status === "closed"
        ? now.nextChange ? t("hours.closedOpens", { time: now.nextChange.at }) : t("hours.closed")
        : t("hours.title");
  const isOpen = now?.status === "open";

  return (
    <>
      <div style={{ height: 1, background: "var(--line)", margin: "var(--space-1) 0" }} />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={days.length === 0}
        style={{ all: "unset", cursor: days.length ? "pointer" : "default", display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 0" }}
      >
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: isOpen ? "var(--success, #2ea056)" : "var(--faint)", flexShrink: 0 }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: isOpen ? "var(--ink)" : "var(--ink-2)", flex: 1 }}>{label}</span>
        {days.length > 0 ? <span aria-hidden style={{ color: "var(--muted)", fontSize: 12, transform: open ? "rotate(180deg)" : "none" }}>▾</span> : null}
      </button>
      {open && days.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0, display: "grid", gap: 3 }}>
          {days.map((line) => (
            <li key={line} style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{line}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

interface RatingSummary {
  roamRating: number | null;
  roamCount: number;
  googleRating: number | null;
  googleCount: number;
  distribution: { stars: number; count: number }[];
}

/**
 * The rating card. The headline follows the SHARED effective-rating rule (effectiveRating) so it
 * matches the venue profile AND the owner dashboard — Roam once it has enough reviews, else Google
 * — with the source labelled. The distribution bars are REAL, built from our own reviews' per-star
 * counts (Google's API returns no breakdown, so we never fabricate one); they appear only once the
 * venue has Roam reviews. The non-headline source is shown as a quiet "also" line.
 */
function RatingCard({ venueId }: { venueId: string }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  const [sum, setSum] = useState<RatingSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = trpc.reviews.summary as unknown as { query: (i: { venueId: string }) => Promise<RatingSummary> };
    q.query({ venueId }).then((s) => { if (!cancelled) setSum(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  if (!sum) return null;
  const eff = effectiveRating(sum);
  if (eff.value == null) return null;

  const totalRoam = sum.distribution.reduce((a, d) => a + d.count, 0);
  const sourceLabel = eff.source === "roam" ? t("ratingCard.roam") : t("ratingCard.google");
  const other =
    eff.source === "roam"
      ? sum.googleRating != null ? { label: t("ratingCard.google"), rating: sum.googleRating, count: sum.googleCount } : null
      : sum.roamCount > 0 && sum.roamRating != null ? { label: t("ratingCard.roam"), rating: sum.roamRating, count: sum.roamCount } : null;

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: "var(--space-4)", background: "var(--paper)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-2)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>{t("ratingCard.title")}</div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--faint)" }}>{sourceLabel}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 34, lineHeight: 1 }}>{eff.value.toFixed(1)}</span>
        <div>
          <Stars n={Math.round(eff.value)} />
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{t("ratingCard.count", { count: eff.count.toLocaleString() })}</div>
        </div>
      </div>

      {totalRoam > 0 ? (
        <div style={{ marginTop: "var(--space-3)", display: "grid", gap: 5 }}>
          {sum.distribution.map((d) => {
            const pct = totalRoam ? Math.round((d.count / totalRoam) * 100) : 0;
            return (
              <div key={d.stars} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 10, fontSize: 12, color: "var(--muted)", textAlign: "right" }}>{d.stars}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 999, background: "var(--paper-2)", overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: "var(--gold, #e0a855)" }} />
                </div>
                <span style={{ width: 34, fontSize: 11.5, color: "var(--muted)", textAlign: "right" }}>{pct}%</span>
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>{t("ratingCard.roamBasis", { count: totalRoam })}</div>
        </div>
      ) : null}

      {other ? (
        <div style={{ marginTop: "var(--space-2)", fontSize: 12, color: "var(--muted)" }}>
          {t("ratingCard.alsoLine", { label: other.label, rating: other.rating.toFixed(1), count: other.count.toLocaleString() })}
        </div>
      ) : null}

      <a href="#reviews" style={{ display: "block", marginTop: "var(--space-3)", textDecoration: "none" }}>
        <Button variant="neutral" size="sm" block>{t("ratingCard.write")}</Button>
      </a>
    </div>
  );
}

/** The dark "own this business?" claim card in the sidebar. */
function ClaimCard({ onClaimPressed }: { onClaimPressed: () => void }) {
  const t = useTranslations("venueDetail");
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, padding: "var(--space-4)", background: "var(--paper-2)" }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", marginBottom: 6 }}>{t("claim.ownTitle")}</div>
      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45, margin: "0 0 var(--space-3)" }}>{t("claim.ownBody")}</p>
      <Button variant="dark" size="sm" block onClick={onClaimPressed}>{t("claim.claimThis")}</Button>
    </div>
  );
}

/** "Where to find it" — the address + locality and a Directions hand-off, plus the suggest-an-edit
 *  seam. A live map is a follow-up (venue coordinates aren't exposed on this read yet). */
function WhereToFind({ venue }: { venue: VenueDetailData }) {
  const t = useTranslations("venueDetail");
  const hasCoords = typeof venue.lat === "number" && typeof venue.lng === "number";
  if (!venue.address && !venue.locality && !hasCoords) return null;
  return (
    <section>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
        {t("whereToFind")}
      </div>
      {hasCoords ? (
        <VenueMap
          venues={[{ id: venue.id, name: venue.name, lat: venue.lat as number, lng: venue.lng as number, claimed: venue.owner_id !== null }]}
          center={{ lat: venue.lat as number, lng: venue.lng as number }}
          className={styles.locMap}
        />
      ) : null}
      <Card flat style={{ padding: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <span aria-hidden style={{ width: 40, height: 40, borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", flexShrink: 0 }}>
            <Icon name="place" size={20} />
          </span>
          <div style={{ flex: 1, minWidth: 180 }}>
            {venue.address ? <div style={{ fontSize: 14, color: "var(--ink)", fontWeight: 600 }}>{venue.address}</div> : null}
            {venue.locality ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{venue.locality}</div> : null}
          </div>
          <DirectionsButton address={venue.address} />
        </div>
      </Card>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-2)", fontSize: 13, color: "var(--ink-2)", flexWrap: "wrap" }}>
        <span style={{ flex: 1, minWidth: 180 }}>{t("suggestEditPrompt")}</span>
        <span style={{ color: "var(--muted)" }}>{t("suggestEdit")}</span>
      </div>
    </section>
  );
}

/**
 * The claim entry point + its live states. The page's single primary CTA when idle;
 * swaps to the auth panel (signed out), a submitting state, the submitted/under-review
 * confirmation, or an error with retry.
 */
function ClaimSection({
  venueId,
  claimUi,
  claimError,
  onClaimPressed,
  onAuthed,
}: {
  venueId: string;
  claimUi: ClaimUiState;
  claimError: string | null;
  onClaimPressed: () => void;
  onAuthed: () => void;
}) {
  const t = useTranslations("venueDetail");
  if (claimUi === "submitted") {
    return <ClaimSubmittedCard />;
  }

  if (claimUi === "auth") {
    return (
      <AuthPanel
        intro={t("claim.intro")}
        emailRedirectTo={claimReturnUrl(venueId)}
        onAuthed={onAuthed}
      />
    );
  }

  // The unclaimed "two doors" (Discovery design): owners claim; locals suggest an edit.
  // Both feed the unclaimed→claimed enrichment loop. Claim is the page's single crimson CTA;
  // "Suggest an edit" is a dormant seam (the community edit path isn't built yet).
  return (
    <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-6)" }}>
      <Card flat style={{ padding: "var(--space-4)", background: "var(--crimson-tint)", borderColor: "var(--crimson-tint-2)" }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
          {t("claim.ownerTitle")}
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          {t("claim.ownerBody")}
        </p>
        {claimUi === "error" && claimError ? (
          <div style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-3)" }} role="alert">
            {claimError}
          </div>
        ) : null}
        <Button variant="pri" onClick={onClaimPressed} disabled={claimUi === "submitting"}>
          {claimUi === "submitting" ? t("claim.claiming") : claimUi === "error" ? t("claim.tryAgain") : t("claim.cta")}
        </Button>
      </Card>

      <Card flat style={{ padding: "var(--space-4)" }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
          {t("claim.knowTitle")}
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          {t("claim.knowBody")}
        </p>
        <Button
          variant="neutral"
          aria-disabled
          title={t("claim.suggestEditSoon")}
          onClick={(e) => e.preventDefault()}
          style={{ opacity: 0.6, cursor: "default" }}
        >
          ＋ {t("claim.suggestEdit")}
        </Button>
      </Card>
    </div>
  );
}

function ClaimSubmittedCard() {
  const t = useTranslations("venueDetail");
  return (
    <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
        {t("claim.submittedTitle")}
      </div>
      <p style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
        {t("claim.submittedBody")}
      </p>
    </Card>
  );
}

/**
 * Shown when the venue is already in pending_claim status. If the current user just
 * submitted it, we show the warmer "submitted" copy; otherwise a neutral "under review"
 * (someone — possibly someone else — has claimed it and it's being verified). Either
 * way there is NO second claim CTA: the venue isn't claimable again from here.
 */
function PendingClaimDetail({
  venue,
  venueId,
  mineJustSubmitted,
}: {
  venue: VenueDetailData;
  venueId: string;
  mineJustSubmitted: boolean;
}) {
  const t = useTranslations("venueDetail");
  return (
    <VenueProfileShell
      venue={venue}
      venueId={venueId}
      topEntry={
        <div style={{ marginTop: "var(--space-4)" }}>
          {mineJustSubmitted ? (
            <ClaimSubmittedCard />
          ) : (
            <Card flat style={{ padding: "var(--space-4)" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
                {t("claim.underReviewTitle")}
              </div>
              <p style={{ color: "var(--ink-2)", lineHeight: 1.5, margin: 0 }}>{t("claim.underReviewBody")}</p>
            </Card>
          )}
        </div>
      }
      sidebarEntry={null}
    />
  );
}

function DetailsBlock({ venue }: { venue: VenueDetailData }) {
  const t = useTranslations("venueDetail");
  const rows: Array<[string, React.ReactNode]> = [];
  if (venue.address) rows.push([t("details.address"), venue.address]);
  if (venue.locality) rows.push([t("details.locality"), venue.locality]);
  if (venue.region) rows.push([t("details.region"), venue.region]);
  if (venue.phone) {
    rows.push([
      t("details.phone"),
      <a key="tel" href={`tel:${venue.phone.replace(/\s+/g, "")}`} style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>
        {venue.phone}
      </a>,
    ]);
  }
  if (venue.website_url) {
    let host = venue.website_url;
    try {
      host = new URL(venue.website_url).hostname.replace(/^www\./, "");
    } catch {
      /* show as-is */
    }
    rows.push([
      t("details.website"),
      <a key="web" href={venue.website_url} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>
        {host} ↗
      </a>,
    ]);
  }
  return (
    <>
      {rows.length > 0 ? (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-4)" }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: "var(--space-3)",
            }}
          >
            {t("details.title")}
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--space-2) var(--space-4)", margin: 0 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt style={{ color: "var(--muted)", fontSize: 13 }}>{k}</dt>
                <dd style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)" }}>{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
      <GoodToKnow venue={venue} />
    </>
  );
}

/* ── Good to know — the Places attribute facts as grouped chips (0065) ──────────────────── */

/** Attribute key → chip label (catalogue key under venueDetail.goodToKnow.attrs — the attribute
 *  key doubles as the message key), grouped as the section renders them. Only TRUE facts show
 *  (a missing key is "unknown", not "no"); the one exception is cash-only, a true-only flag. */
const GOOD_TO_KNOW_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "serviceOptions",
    keys: ["dineIn", "takeout", "delivery", "curbsidePickup", "reservable"],
  },
  {
    title: "dining",
    keys: [
      "servesBreakfast",
      "servesBrunch",
      "servesLunch",
      "servesDinner",
      "servesCoffee",
      "servesDessert",
      "servesBeer",
      "servesWine",
      "servesCocktails",
      "servesVegetarianFood",
    ],
  },
  {
    title: "amenities",
    keys: [
      "outdoorSeating",
      "liveMusic",
      "goodForGroups",
      "goodForChildren",
      "menuForChildren",
      "goodForWatchingSports",
      "allowsDogs",
      "restroom",
    ],
  },
];

const OPTION_GROUPS: { title: string; source: string; keys: string[] }[] = [
  {
    title: "payments",
    source: "paymentOptions",
    keys: ["acceptsNfc", "acceptsCreditCards", "acceptsDebitCards", "acceptsCashOnly"],
  },
  {
    title: "parking",
    source: "parkingOptions",
    keys: [
      "freeParkingLot",
      "paidParkingLot",
      "freeStreetParking",
      "paidStreetParking",
      "freeGarageParking",
      "paidGarageParking",
      "valetParking",
    ],
  },
  {
    title: "accessibility",
    source: "accessibilityOptions",
    keys: [
      "wheelchairAccessibleEntrance",
      "wheelchairAccessibleParking",
      "wheelchairAccessibleRestroom",
      "wheelchairAccessibleSeating",
    ],
  },
];

/** Format a stored price range as "£10–20" (symbol for the common currencies, code otherwise). */
function priceRangeLabel(
  t: ReturnType<typeof useTranslations>,
  pr: NonNullable<VenueDetailData["price_range"]>,
): string | null {
  const sym = pr.currency === "GBP" ? "£" : pr.currency === "EUR" ? "€" : pr.currency === "USD" ? "$" : pr.currency ? `${pr.currency} ` : "";
  if (pr.start !== null && pr.end !== null) return `${sym}${pr.start}–${pr.end}`;
  if (pr.start !== null) return `${sym}${pr.start}+`;
  if (pr.end !== null) return t("goodToKnow.upTo", { price: `${sym}${pr.end}` });
  return null;
}

function GoodToKnow({ venue, unclaimed = false }: { venue: VenueDetailData; unclaimed?: boolean }) {
  const t = useTranslations("venueDetail");
  const attrs = venue.attributes ?? null;
  const price = venue.price_range ? priceRangeLabel(t, venue.price_range) : null;

  const groups: { title: string; labels: string[] }[] = [];
  if (attrs) {
    for (const g of GOOD_TO_KNOW_GROUPS) {
      const labels = g.keys.filter((k) => attrs[k] === true).map((k) => t(`goodToKnow.attrs.${k}`));
      if (labels.length > 0) groups.push({ title: t(`goodToKnow.groups.${g.title}`), labels });
    }
    for (const g of OPTION_GROUPS) {
      const bag = attrs[g.source];
      if (!bag || typeof bag !== "object") continue;
      const labels = g.keys.filter((k) => bag[k] === true).map((k) => t(`goodToKnow.attrs.${k}`));
      if (labels.length > 0) groups.push({ title: t(`goodToKnow.groups.${g.title}`), labels });
    }
  }
  if (groups.length === 0 && !price) return null;

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
          {t("goodToKnow.title")}
        </div>
        {unclaimed ? (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{venue.source_attribution ?? t("fromPublicSources")}</span>
        ) : price ? (
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--crimson-700)", background: "var(--crimson-tint)", borderRadius: 999, padding: "3px 10px" }}>
            {price} <span style={{ fontWeight: 400 }}>{t("goodToKnow.perPerson")}</span>
          </span>
        ) : null}
      </div>
      {groups.length > 0 ? (
        <Card flat style={{ padding: "0 var(--space-4)" }}>
          {groups.map((g) => (
            <div key={g.title} className={styles.gtkRow}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{g.title}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {g.labels.map((label) => (
                  <span
                    key={label}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)", background: "var(--paper-2)", borderRadius: 999, padding: "5px 11px" }}
                  >
                    <Icon name="check" size={12} style={{ color: "var(--success)" }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </Card>
      ) : null}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div>
      <div style={{ height: 200, borderRadius: 16, background: "var(--paper-2)", marginBottom: "var(--space-4)" }} />
      <div style={{ height: 28, width: "55%", background: "var(--paper-2)", borderRadius: 8 }} />
      <div style={{ height: 14, width: "30%", background: "var(--paper-2)", borderRadius: 6, marginTop: "var(--space-3)" }} />
      <div style={{ height: 60, background: "var(--paper-2)", borderRadius: 10, marginTop: "var(--space-4)" }} />
    </div>
  );
}

function NotFoundState() {
  const t = useTranslations("venueDetail");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("notFound.title")}
      </div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        {t("notFound.body")}
      </p>
      <Link href="/explore" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← {t("notFound.backToExplore")}</Pill>
      </Link>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const t = useTranslations("venueDetail");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("errors.title")}
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}

/**
 * Opening hours — renders the 7 human-readable day strings our ingest stores
 * (OpeningTimes.weekdayDescriptions from @roam/core/places). Tolerant by design:
 * renders nothing when hours are absent or malformed, so a venue without hours simply
 * omits the block rather than showing an empty shell. Hours are venue facts (shown in
 * every loaded state), not claim-state facts.
 */
function OpeningHours({ openingTimes }: { openingTimes: VenueDetailData["opening_times"] }) {
  const t = useTranslations("venueDetail");
  const days = openingTimes?.weekdayDescriptions;
  if (!Array.isArray(days) || days.length === 0) return null;
  const clean = days.filter((d): d is string => typeof d === "string" && d.length > 0);
  if (clean.length === 0) return null;

  // "Open now" status — computed at render from structured periods + timezone (owner
  // venues only). Returns status 'unknown' for legacy Places string-only hours, in
  // which case we show no pill and render exactly as before. Evaluated once at render
  // (accurate on load); a live-ticking clock is intentionally deferred.
  const open = isOpenNow(openingTimes, new Date());
  const pill =
    open.status === "open"
      ? { text: open.nextChange ? t("hours.openNowCloses", { time: open.nextChange.at }) : t("hours.openNow"), on: true }
      : open.status === "closed"
        ? { text: open.nextChange ? t("hours.closedOpens", { time: open.nextChange.at }) : t("hours.closed"), on: false }
        : null;
  return (
    <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-4)" }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: "var(--space-3)",
        }}
      >
        {t("hours.title")}
      </div>
      {pill ? (
        <div
          style={{
            display: "inline-block",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "2px 10px",
            borderRadius: 999,
            marginBottom: "var(--space-3)",
            color: pill.on ? "var(--ink)" : "var(--ink-2)",
            background: pill.on ? "var(--line)" : "transparent",
            border: pill.on ? "none" : "1px solid var(--line-2)",
          }}
        >
          {pill.text}
        </div>
      ) : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-1)" }}>
        {clean.map((line) => (
          <li key={line} style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {line}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DirectionsButton({ address, block = false }: { address: string | null; block?: boolean }) {
  const t = useTranslations("venueDetail");
  // Hand off to the device's DEFAULT maps app (iOS → Apple Maps, Android → the user's
  // default via geo:, desktop → Google web). SSR can't know the platform, so we render the
  // web URL first and swap to the device-specific one after mount. Hooks run unconditionally
  // (before the no-address early return) to satisfy the rules of hooks.
  const [href, setHref] = useState(() => (address ? directionsUrl(address, "web") : ""));
  useEffect(() => {
    if (!address) return;
    const platform = detectMapsPlatform(
      navigator.userAgent,
      navigator.maxTouchPoints,
      navigator.platform,
    );
    setHref(directionsUrl(address, platform));
  }, [address]);

  if (!address) return null;
  // An app-scheme link (geo:) must navigate in place so the OS can intercept it; an https
  // link (Apple/Google web) opens in a new tab so the user keeps Roam open.
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      style={{ textDecoration: "none", ...(block ? { display: "block" } : {}) }}
    >
      <Button variant="neutral" block={block} size={block ? "md" : "sm"}>
        {t("getDirections")} ↗
      </Button>
    </a>
  );
}

/** Pull renderable string links from the venue `links` jsonb (Order/Book/Menu URLs). */
function linkEntries(links: Record<string, unknown> | null): Array<[string, string]> {
  if (!links || typeof links !== "object") return [];
  return Object.entries(links).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0,
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The URL the email-confirmation link returns to: this venue page with the claim
 * resume flag, so a confirmed sign-up lands back ready to finish. Uses
 * NEXT_PUBLIC_SITE_URL (the project's domain source of truth) with the same localhost
 * fallback the tRPC client uses, and never throws at module/runtime if unset.
 */
function claimReturnUrl(venueId: string): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/venue/${venueId}?claim=1`;
}

/* ── Reviews ──────────────────────────────────────────────────────────────────────────────────
 * Roam's own reviews on a venue (migration 0085): a rating headline that PREFERS the Roam score
 * once the venue has enough Roam reviews (else falls back to Google), the caller's own editable
 * review, and everyone else's. This is the surface where Roam reviews begin to supersede Google.
 */

/** How many Roam reviews a venue needs before its Roam rating replaces Google's in the headline. */
const ROAM_RATING_OVERRIDE_MIN = ROAM_RATING_MIN;

interface RoamReview {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  authorId: string;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatar: string | null;
}
interface ReviewSummary {
  roamRating: number | null;
  roamCount: number;
  googleRating: number | null;
  googleCount: number;
}

interface GoogleReviewView {
  id: string;
  authorName: string;
  authorPhotoUri: string | null;
  authorUri: string | null;
  rating: number;
  text: string | null;
  relativeTime: string | null;
}

function VenueReviews({ venueId, placeId, venueName }: { venueId: string; placeId: string | null; venueName?: string }) {
  const t = useTranslations("venueDetail");
  const trpc = useTrpc();
  const session = useSession();
  const me = session?.user?.id ?? null;

  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [reviews, setReviews] = useState<RoamReview[]>([]);
  const [mine, setMine] = useState<{ rating: number; body: string | null } | null>(null);

  const [draftRating, setDraftRating] = useState(0);
  const [draftBody, setDraftBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Google reviews: fetched on demand (a paid Places call), not on mount. null = not yet asked.
  const [googleReviews, setGoogleReviews] = useState<GoogleReviewView[] | null>(null);
  const [googleMapsUri, setGoogleMapsUri] = useState<string | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const writeReviewUrl = placeId ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}` : null;

  const loadGoogle = useCallback(async () => {
    setGoogleLoading(true);
    try {
      const res = await fetch("/api/google-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId }),
      });
      const data = res.ok ? ((await res.json()) as { reviews?: GoogleReviewView[]; googleMapsUri?: string | null }) : { reviews: [] };
      setGoogleReviews(data.reviews ?? []);
      setGoogleMapsUri(data.googleMapsUri ?? null);
    } catch {
      setGoogleReviews([]);
    } finally {
      setGoogleLoading(false);
    }
  }, [venueId]);

  const load = useCallback(async () => {
    const sumQ = trpc.reviews.summary as unknown as { query: (i: { venueId: string }) => Promise<ReviewSummary> };
    const listQ = trpc.reviews.list as unknown as { query: (i: { venueId: string; limit: number; offset: number }) => Promise<{ reviews: RoamReview[] }> };
    const [s, l] = await Promise.all([sumQ.query({ venueId }), listQ.query({ venueId, limit: 20, offset: 0 })]);
    setSummary(s);
    setReviews(l.reviews ?? []);
    if (me) {
      const mineQ = trpc.reviews.mine as unknown as { query: (i: { venueId: string }) => Promise<{ review: { rating: number; body: string | null } | null }> };
      const r = await mineQ.query({ venueId });
      setMine(r.review);
      setDraftRating(r.review?.rating ?? 0);
      setDraftBody(r.review?.body ?? "");
    } else {
      setMine(null);
    }
  }, [trpc, venueId, me]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setErr(t("reviews.loadError"));
    });
    return () => {
      cancelled = true;
    };
  }, [load, t]);

  const submit = useCallback(async () => {
    if (draftRating < 1) {
      setErr(t("reviews.ratingRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    const save = trpc.reviews.save as unknown as { mutate: (i: { venueId: string; rating: number; body: string | null }) => Promise<unknown> };
    try {
      await save.mutate({ venueId, rating: draftRating, body: draftBody.trim() || null });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("reviews.saveError"));
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, draftRating, draftBody, load, t]);

  const remove = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const del = trpc.reviews.remove as unknown as { mutate: (i: { venueId: string }) => Promise<unknown> };
    try {
      await del.mutate({ venueId });
      setDraftRating(0);
      setDraftBody("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("reviews.saveError"));
    } finally {
      setBusy(false);
    }
  }, [trpc, venueId, load, t]);

  const others = reviews.filter((r) => r.authorId !== me);
  const roamPrimary = !!summary && summary.roamRating != null && summary.roamCount >= ROAM_RATING_OVERRIDE_MIN;

  return (
    <section style={{ marginTop: "var(--space-8)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
        {t("reviews.title")}
      </div>

      {/* Rating headline — Roam once it has enough reviews, else Google (the "supersede" switch). */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        {roamPrimary ? (
          <>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22 }}>★ {summary!.roamRating!.toFixed(1)}</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{t("reviews.countOnRoam", { count: summary!.roamCount })}</span>
            {summary!.googleRating != null ? (
              <span style={{ fontSize: 12.5, color: "var(--faint)" }}>· {t("reviews.googleFigure", { rating: summary!.googleRating.toFixed(1), count: summary!.googleCount })}</span>
            ) : null}
          </>
        ) : summary && summary.googleRating != null ? (
          <>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22 }}>★ {summary.googleRating.toFixed(1)}</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{t("reviews.googleCount", { count: summary.googleCount })}</span>
            {summary.roamCount > 0 && summary.roamRating != null ? (
              <span style={{ fontSize: 12.5, color: "var(--faint)" }}>· {t("reviews.roamFigure", { rating: summary.roamRating.toFixed(1), count: summary.roamCount })}</span>
            ) : null}
          </>
        ) : summary && summary.roamCount > 0 && summary.roamRating != null ? (
          <>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22 }}>★ {summary.roamRating.toFixed(1)}</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>{t("reviews.countOnRoam", { count: summary.roamCount })}</span>
          </>
        ) : (
          <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{t("reviews.none")}</span>
        )}
      </div>

      {/* Write / edit the caller's own review. */}
      {me ? (
        <Card flat style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
          {mine ? (
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: "var(--space-2)" }}>{t("reviews.yourReview")}</div>
          ) : (
            <div style={{ marginBottom: "var(--space-2)" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{venueName ? t("reviews.promptNamed", { name: venueName }) : t("reviews.write")}</div>
              <div style={{ fontSize: 13, color: "var(--muted)" }}>{t("reviews.promptSub")}</div>
            </div>
          )}
          <StarInput value={draftRating} onChange={setDraftRating} label={t("reviews.ratingAria")} />
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            placeholder={t("reviews.placeholder")}
            rows={3}
            maxLength={4000}
            style={{ width: "100%", boxSizing: "border-box", marginTop: "var(--space-2)", padding: "10px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: "var(--r-md)", fontFamily: "var(--ui)", fontSize: 15, color: "var(--ink)", outline: "none", resize: "vertical" }}
          />
          {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }}>{err}</div> : null}
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", alignItems: "center" }}>
            <Button variant="pri" size="sm" onClick={() => void submit()} disabled={busy || draftRating < 1}>
              {busy ? t("reviews.saving") : mine ? t("reviews.update") : t("reviews.post")}
            </Button>
            {mine ? (
              <button type="button" onClick={() => void remove()} disabled={busy} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 13, textDecoration: "underline" }}>
                {t("reviews.remove")}
              </button>
            ) : null}
          </div>
        </Card>
      ) : (
        <div style={{ fontSize: 13.5, color: "var(--ink-2)", marginBottom: "var(--space-4)" }}>{t("reviews.signInToReview")}</div>
      )}

      {/* Everyone else's reviews. */}
      {others.length > 0 ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {others.map((r) => (
            <Card key={r.id} flat style={{ padding: "var(--space-3) var(--space-4)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 6 }}>
                <ReviewAvatar name={r.authorName} handle={r.authorHandle} avatar={r.authorAvatar} />
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.authorName || (r.authorHandle ? `@${r.authorHandle}` : t("reviews.someone"))}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{shortDate(r.createdAt)}</span>
              </div>
              <Stars n={r.rating} />
              {r.body ? <p style={{ margin: "6px 0 0", lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{r.body}</p> : null}
            </Card>
          ))}
        </div>
      ) : null}

      {/* Google reviews — read-only, fetched on demand, shown with attribution (never stored). */}
      {placeId ? (
        <div style={{ marginTop: "var(--space-6)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>{t("reviews.googleTitle")}</span>
            <span style={{ flex: 1 }} />
            {writeReviewUrl ? (
              <a href={writeReviewUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none" }}>
                {t("reviews.writeGoogle")} <span aria-hidden>↗</span>
              </a>
            ) : null}
          </div>

          {googleReviews === null ? (
            <Button variant="neutral" size="sm" onClick={() => void loadGoogle()} disabled={googleLoading}>
              {googleLoading ? t("reviews.googleLoading") : t("reviews.showGoogle")}
            </Button>
          ) : googleReviews.length === 0 ? (
            <div style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{t("reviews.googleEmpty")}</div>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {googleReviews.map((r) => (
                <Card key={r.id} flat style={{ padding: "var(--space-3) var(--space-4)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 6 }}>
                    <ReviewAvatar name={r.authorName} handle={null} avatar={r.authorPhotoUri} />
                    {r.authorUri ? (
                      <a href={r.authorUri} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink)", textDecoration: "none" }}>{r.authorName}</a>
                    ) : (
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.authorName}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {r.relativeTime ? <span style={{ fontSize: 12, color: "var(--muted)" }}>{r.relativeTime}</span> : null}
                  </div>
                  <Stars n={r.rating} />
                  {r.text ? <p style={{ margin: "6px 0 0", lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{r.text}</p> : null}
                </Card>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: 12, color: "var(--muted)" }}>
                <span>{t("reviews.poweredByGoogle")}</span>
                {googleMapsUri ? (
                  <a href={googleMapsUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--muted)", textDecoration: "underline" }}>{t("reviews.viewOnGoogle")}</a>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** A 1–5 star picker (radiogroup) for writing a review. */
function StarInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", gap: 4 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={String(n)}
          onClick={() => onChange(n)}
          style={{ all: "unset", cursor: "pointer", fontSize: 26, lineHeight: 1, color: n <= value ? "var(--gold)" : "var(--faint)" }}
        >
          {n <= value ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}

/** A read-only 5-star rating display. */
function Stars({ n }: { n: number }) {
  return (
    <span aria-label={`${n} / 5`} style={{ letterSpacing: 1, fontSize: 13 }}>
      <span style={{ color: "var(--gold)" }}>{"★".repeat(Math.max(0, Math.min(5, n)))}</span>
      <span style={{ color: "var(--faint)" }}>{"★".repeat(Math.max(0, 5 - n))}</span>
    </span>
  );
}

function ReviewAvatar({ name, handle, avatar }: { name: string | null; handle: string | null; avatar: string | null }) {
  const size = 26;
  if (avatar) {
    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL; next/image adds no value here
    return <img src={avatar} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  const ch = (name || handle || "·").replace(/^@/, "").charAt(0).toUpperCase() || "·";
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
      {ch}
    </span>
  );
}
