-- ============================================================================
-- Roam pre-F2G baseline — Venues and discovery
-- Generated from the final schema at migration 0115; see migrations/README.md.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "public"."venue_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "claimant_id" "uuid" NOT NULL,
    "status" "public"."venue_claim_status" DEFAULT 'pending'::"public"."venue_claim_status" NOT NULL,
    "note" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verified_domain" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."venue_claims" OWNER TO "postgres";


COMMENT ON TABLE "public"."venue_claims" IS 'Claim REQUESTS (claim-as-request). A pending row means "someone asked to own this venue; awaiting verification" — a true state, never premature ownership. Ownership is conferred only on approval by setting venues.owner_id via service role. Table (not a column) so the eventual review queue gets history + competing claims + audit for free.';


COMMENT ON COLUMN "public"."venue_claims"."verified_domain" IS 'True when the claimant''s (non-free) email host matched a host in the venue''s links at claim time. NOT a gate (claims are self-serve) — a moderation trust signal for triage.';


CREATE TABLE IF NOT EXISTS "public"."places_fetch_quota" (
    "bucket" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "calls" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."places_fetch_quota" OWNER TO "postgres";


COMMENT ON TABLE "public"."places_fetch_quota" IS 'Counters for the on-demand Places ingestion cost control: a global daily paid-call budget and per-client rolling-window limits. Written only by claim_places_fetch_quota (SECURITY DEFINER), reached only via the api internalProcedure. Stale rows are pruned opportunistically by the same function.';


CREATE TABLE IF NOT EXISTS "public"."venue_activity" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "actor_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_at" timestamp with time zone
);


ALTER TABLE "public"."venue_activity" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "is_cover" boolean DEFAULT false NOT NULL,
    "places_photo_ref" "text",
    "attribution" "jsonb",
    "storage_path" "text",
    "alt_text" "text",
    "width" integer,
    "height" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "owner_shape" CHECK ((("source" <> 'owner_upload'::"text") OR (("storage_path" IS NOT NULL) AND ("places_photo_ref" IS NULL)))),
    CONSTRAINT "places_shape" CHECK ((("source" <> 'google_places'::"text") OR (("places_photo_ref" IS NOT NULL) AND ("storage_path" IS NULL)))),
    CONSTRAINT "venue_photos_source_check" CHECK (("source" = ANY (ARRAY['google_places'::"text", 'owner_upload'::"text"])))
);


ALTER TABLE "public"."venue_photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "author_id" "uuid" NOT NULL,
    "rating" integer NOT NULL,
    "body" "text",
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "venue_reviews_body_len" CHECK ((("body" IS NULL) OR ("char_length"("body") <= 4000))),
    CONSTRAINT "venue_reviews_rating_range" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."venue_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_views" (
    "venue_id" "uuid" NOT NULL,
    "day" "date" NOT NULL,
    "views" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."venue_views" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "status" "public"."venue_status" DEFAULT 'unclaimed'::"public"."venue_status" NOT NULL,
    "name" "text" NOT NULL,
    "source" "text",
    "source_ref" "text",
    "source_attribution" "text" DEFAULT 'Information from public sources'::"text",
    "geo" "public"."geography"(Point,4326) NOT NULL,
    "address" "text",
    "locality" "text",
    "region" "text",
    "country_code" character(2),
    "category" "text",
    "categories" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "rating" numeric(2,1),
    "rating_count" integer DEFAULT 0 NOT NULL,
    "owner_id" "uuid",
    "description" "text",
    "opening_times" "jsonb",
    "dress_code" "text",
    "links" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "custom_sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "subscription_tier" "public"."subscription_tier" DEFAULT 'free'::"public"."subscription_tier" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fetched_at" timestamp with time zone,
    "price_level" "text",
    "primary_type_label" "text",
    "business_status" "text",
    "slug" "text" NOT NULL,
    "phone" "text",
    "website_url" "text",
    "price_range" "jsonb",
    "attributes" "jsonb",
    "details_fetched_at" timestamp with time zone,
    "roam_rating" numeric(2,1),
    "roam_rating_count" integer DEFAULT 0 NOT NULL,
    "lat" double precision GENERATED ALWAYS AS ("public"."st_y"(("geo")::"public"."geometry")) STORED,
    "lng" double precision GENERATED ALWAYS AS ("public"."st_x"(("geo")::"public"."geometry")) STORED,
    CONSTRAINT "venues_opening_times_owner_shape" CHECK ((("opening_times" IS NULL) OR (NOT ("opening_times" ? 'periods'::"text")) OR (("jsonb_typeof"(("opening_times" -> 'periods'::"text")) = 'array'::"text") AND (("opening_times" ->> 'source'::"text") = 'owner'::"text"))))
);


ALTER TABLE "public"."venues" OWNER TO "postgres";


COMMENT ON TABLE "public"."venues" IS 'Global venue model. Unclaimed (Google Places base) is the median launch state worldwide and must be a graceful, non-embarrassing experience: browsable, plannable, navigable without an owner.';


COMMENT ON COLUMN "public"."venues"."fetched_at" IS 'Last time this row''s content was (re)fetched from its external source (Places API New). NULL = never fetched / not externally sourced. Drives the on-demand ingestion freshness check; distinct from updated_at (modification time).';


COMMENT ON COLUMN "public"."venues"."details_fetched_at" IS 'When the on-demand Places Details enrichment last ran for this venue (0080). NULL = never enriched (eligible for one Details call). Distinguishes "not tried" from "tried, Places had no rich facts", so enrichment never re-pays for the same venue.';


COMMENT ON COLUMN "public"."venues"."roam_rating" IS 'Average of this venue''s approved Roam reviews (1.0–5.0), NULL when it has none. Maintained by trg_venue_reviews_rollup. The venue profile shows this in place of the Google rating once roam_rating_count crosses the client threshold — the path to Roam reviews superseding Google.';


COMMENT ON COLUMN "public"."venues"."lat" IS 'Latitude, generated from geo — lets `select *` reads render a map without a spatial call.';


COMMENT ON COLUMN "public"."venues"."lng" IS 'Longitude, generated from geo.';
