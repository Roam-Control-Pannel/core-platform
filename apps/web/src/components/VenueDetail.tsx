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
import { selectHero, galleryOrder, type PhotoRow } from "../lib/venuePhotos";
import Link from "next/link";
import { Card, Pill, Rate, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { FollowButton } from "./FollowButton";
import { ReportVenue } from "./ReportVenue";
import { isOpenNow } from "../lib/openNow";
import { directionsUrl, detectMapsPlatform } from "../lib/directions";
import styles from "./VenueDetail.module.css";

/**
 * The byId result is the full venues Row (select("*")). We read it loosely here —
 * the fields we render are a stable subset; `geo` (PostGIS `unknown`) is never touched
 * client-side (proximity is the RPC's job, not this page's).
 */
interface VenueDetailData {
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
}

/** Where the claim CTA currently stands, locally. Drives which affordance shows. */
type ClaimUiState =
  | "idle" // not started
  | "auth" // signed out, AuthPanel showing
  | "submitting" // requestClaim in flight
  | "submitted" // success — under review
  | "error"; // requestClaim failed (message in claimError)

export function VenueDetail({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const [venue, setVenue] = useState<VenueDetailData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const [claimUi, setClaimUi] = useState<ClaimUiState>("idle");
  const [claimError, setClaimError] = useState<string | null>(null);

  // Follow state for THIS venue, read once after load from the caller's myFollows.
  // undefined = not yet known (button renders its default-off until this resolves);
  // a claimed venue is the only state that shows a FollowButton (see ClaimedDetail).
  const [following, setFollowing] = useState<boolean | undefined>(undefined);

  const loadVenue = useCallback(async () => {
    setVenue(undefined);
    setError(null);
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
      throw e instanceof Error ? e : new Error("Failed to load venue.");
    }
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    loadVenue()
      .then((v) => {
        if (!cancelled) setVenue(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load venue.");
      });
    return () => {
      cancelled = true;
    };
  }, [loadVenue]);

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
      setClaimError(e instanceof Error ? e.message : "Couldn't submit your claim.");
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
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
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
      <span aria-hidden>←</span> Explore
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
        <span style={{ fontSize: 40, color: "var(--crimson-700)", opacity: 0.5 }}>◍</span>
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
type VenueTab = "details" | "posts" | "offers" | "shop";

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
  const links = linkEntries(venue.links);
  // Only "details" is reachable today; keeping it in state lets the dormant tabs light up
  // with no structural change once Posts/Offers/Shop ship.
  const [tab, setTab] = useState<VenueTab>("details");

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
              Manage this venue <span aria-hidden>→</span>
            </Link>
          ) : null}

          <VenueActions venueId={venueId} initialFollowing={initialFollowing} address={venue.address} />

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
          <div className={styles.tabstrip} role="tablist" aria-label="Venue sections">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "details"}
              className={tab === "details" ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab("details")}
            >
              Details
            </button>
            <DormantTab label="Posts" />
            <DormantTab label="Offers" />
            <DormantTab label="Shop ◇" />
          </div>

          {venue.description ? (
            <p style={{ marginTop: 0, lineHeight: 1.6, color: "var(--ink-2)" }}>{venue.description}</p>
          ) : null}

          <OpeningHours openingTimes={venue.opening_times} />
          <DetailsBlock venue={venue} />
        </div>
      </div>
    </>
  );
}

/** A faint, inert tab — a Stage-2 surface seam (Posts · Offers · Shop) not yet built. */
function DormantTab({ label }: { label: string }) {
  return (
    <span className={`${styles.tab} ${styles.tabDormant}`} title="Coming soon" aria-disabled>
      {label}
    </span>
  );
}

/**
 * The claimed-venue action cluster (Discovery design #3): Follow · ＋Add to Plan · Get
 * Directions in a single row. Follow is the live primary; Add to Plan is a dormant Stage-2
 * (Social) seam; Directions hands off to the device maps app. Lives in the sticky aside so
 * it stays reachable as the tabbed content scrolls.
 */
function VenueActions({
  venueId,
  initialFollowing,
  address,
}: {
  venueId: string;
  initialFollowing: boolean;
  address: string | null;
}) {
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
      <FollowButton
        venueId={venueId}
        initialFollowing={initialFollowing}
        emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
      />
      <Button
        variant="neutral"
        size="sm"
        aria-disabled
        title="Plans are coming soon"
        onClick={(e) => e.preventDefault()}
        style={{ opacity: 0.6, cursor: "default" }}
      >
        ＋ Add to Plan
      </Button>
      <DirectionsButton address={address} />
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
  return (
    <>
      <VenuePhotos venueId={venueId} claimed={false} />
      <TitleRow name={venue.name} />
      <div style={{ marginTop: "var(--space-2)", fontSize: 13.5, color: "var(--ink-2)" }}>
        {venue.category ? <span>{venue.category}</span> : null}
        {venue.category && venue.locality ? <span> · </span> : null}
        {venue.locality ? <span>{venue.locality}</span> : null}
      </div>

      {/* Provenance, stated plainly — "new, not dead". NO rating by design. */}
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: ".04em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginTop: "var(--space-3)",
        }}
      >
        {venue.source_attribution ?? "From public sources"}
      </div>

      <ClaimSection
        venueId={venueId}
        claimUi={claimUi}
        claimError={claimError}
        onClaimPressed={onClaimPressed}
        onAuthed={onAuthed}
      />

      <OpeningHours openingTimes={venue.opening_times} />
      <DetailsBlock venue={venue} />
      <ActionRow address={venue.address} />
    </>
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
  if (claimUi === "submitted") {
    return <ClaimSubmittedCard />;
  }

  if (claimUi === "auth") {
    return (
      <AuthPanel
        intro="Claiming is free. Sign in or create an account and this venue is yours to manage right away."
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
          Is this your business?
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          Claim it free to add photos, opening times, your menu and links, and post offers and
          events to people nearby — about 90 seconds, and you can start editing straight away.
        </p>
        {claimUi === "error" && claimError ? (
          <div style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-3)" }} role="alert">
            {claimError}
          </div>
        ) : null}
        <Button variant="pri" onClick={onClaimPressed} disabled={claimUi === "submitting"}>
          {claimUi === "submitting" ? "Claiming…" : claimUi === "error" ? "Try again" : "Claim this venue"}
        </Button>
      </Card>

      <Card flat style={{ padding: "var(--space-4)" }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
          Know this place?
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          Help fellow locals — suggest a photo, the opening hours, or a fix.
        </p>
        <Button
          variant="neutral"
          aria-disabled
          title="Suggesting edits is coming soon"
          onClick={(e) => e.preventDefault()}
          style={{ opacity: 0.6, cursor: "default" }}
        >
          ＋ Suggest an edit
        </Button>
      </Card>
    </div>
  );
}

function ClaimSubmittedCard() {
  return (
    <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
        Claim submitted
      </div>
      <p style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
        Thanks — your claim is now with us for verification. Once it&apos;s approved you&apos;ll
        be able to manage this venue, add photos and details, and post to people nearby.
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
  return (
    <>
      <VenuePhotos venueId={venueId} claimed={false} />
      <TitleRow name={venue.name} />
      <div style={{ marginTop: "var(--space-2)", fontSize: 13.5, color: "var(--ink-2)" }}>
        {venue.category ? <span>{venue.category}</span> : null}
        {venue.category && venue.locality ? <span> · </span> : null}
        {venue.locality ? <span>{venue.locality}</span> : null}
      </div>

      {mineJustSubmitted ? (
        <ClaimSubmittedCard />
      ) : (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: "var(--space-2)",
            }}
          >
            Claim under review
          </div>
          <p style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
            A claim for this venue has been submitted and is being verified. Check back soon —
            once it&apos;s approved the venue&apos;s owner can keep its details up to date.
          </p>
        </Card>
      )}

      <OpeningHours openingTimes={venue.opening_times} />
      <DetailsBlock venue={venue} />
      <ActionRow address={venue.address} />
    </>
  );
}

function DetailsBlock({ venue }: { venue: VenueDetailData }) {
  const rows: Array<[string, string]> = [];
  if (venue.address) rows.push(["Address", venue.address]);
  if (venue.locality) rows.push(["Locality", venue.locality]);
  if (venue.region) rows.push(["Region", venue.region]);
  if (rows.length === 0) return null;
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
        Details
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
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Venue not found
      </div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        This venue may have been removed, or the link is wrong.
      </p>
      <Link href="/explore" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← Back to Explore</Pill>
      </Link>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load this venue
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
      ? { text: open.nextChange ? `Open now · closes ${open.nextChange.at}` : "Open now", on: true }
      : open.status === "closed"
        ? { text: open.nextChange ? `Closed · opens ${open.nextChange.at}` : "Closed", on: false }
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
        Opening hours
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

/**
 * Action cluster (Discovery design): "＋ Add to Plan" + "Get Directions". Both work even on
 * an unclaimed venue with zero owner content — the venue is never a dead end. Add to Plan is
 * a dormant Stage-2 (Social) seam; Directions opens the device maps app by address text (not
 * lat/lng) so the provider resolves the named place rather than dropping an unlabelled pin.
 */
function ActionRow({ address }: { address: string | null }) {
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
      <Button
        variant="neutral"
        size="sm"
        aria-disabled
        title="Plans are coming soon"
        onClick={(e) => e.preventDefault()}
        style={{ opacity: 0.6, cursor: "default" }}
      >
        ＋ Add to Plan
      </Button>
      <DirectionsButton address={address} />
    </div>
  );
}

function DirectionsButton({ address }: { address: string | null }) {
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
      style={{ textDecoration: "none" }}
    >
      <Button variant="neutral" size="sm">
        Get Directions ↗
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
