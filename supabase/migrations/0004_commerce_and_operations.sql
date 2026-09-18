-- ============================================================================
-- Roam pre-F2G baseline — Commerce and operations
-- Generated from the final schema at migration 0115; see migrations/README.md.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "public"."admin_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_id" "uuid",
    "actor_email" "text",
    "action" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "uuid",
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."admin_audit_log" IS 'Append-only record of privileged Roam HQ actions, attributed to the acting staff member. Written by the api adminProcedure (service-role). RLS on with no policies = no user access.';


CREATE TABLE IF NOT EXISTS "public"."admin_users" (
    "id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'viewer'::"text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "admin_users_role_check" CHECK (("role" = ANY (ARRAY['viewer'::"text", 'admin'::"text", 'owner'::"text"])))
);


ALTER TABLE "public"."admin_users" OWNER TO "postgres";


COMMENT ON TABLE "public"."admin_users" IS 'Roam HQ staff allowlist. A row grants a profile privileged (cross-tenant, RLS-bypassing) access via the api adminProcedure. Membership is service-role-granted only; users may read only their own row.';


CREATE TABLE IF NOT EXISTS "public"."automation_journeys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "definition" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."automation_journeys" OWNER TO "postgres";


COMMENT ON TABLE "public"."automation_journeys" IS 'DORMANT Stage-5 seam (automation). Modelled now; gated by feature_flags.automation.enabled.';


CREATE TABLE IF NOT EXISTS "public"."awin_deals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "awin_promotion_id" "text",
    "advertiser_id" "text" NOT NULL,
    "advertiser_name" "text",
    "title" "text" NOT NULL,
    "description" "text",
    "kind" "text" DEFAULT 'offer'::"text" NOT NULL,
    "voucher_code" "text",
    "terms" "text",
    "destination_url" "text" NOT NULL,
    "image_url" "text",
    "category" "text",
    "region" "text",
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "awin_deals_kind_check" CHECK (("kind" = ANY (ARRAY['offer'::"text", 'voucher'::"text"])))
);


ALTER TABLE "public"."awin_deals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_customers" (
    "venue_id" "uuid" NOT NULL,
    "stripe_customer_id" "text",
    "tier" "public"."subscription_tier" DEFAULT 'free'::"public"."subscription_tier" NOT NULL,
    "current_period_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."billing_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "stripe_payment_intent" "text",
    "stripe_charge_id" "text",
    "amount_pence" integer NOT NULL,
    "vat_pence" integer DEFAULT 0 NOT NULL,
    "currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "refunded_pence" integer DEFAULT 0 NOT NULL,
    "refunded_at" timestamp with time zone,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."billing_transactions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."billing_transactions"."refunded_pence" IS 'Closes the DDS gap: the charge.refunded webhook MUST update this (and refunded_at). A refund is a real state change, never a 200-skipped no-op.';


CREATE TABLE IF NOT EXISTS "public"."birthday_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "delivered_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "code" "text",
    "expires_at" "date",
    "redeemed_at" timestamp with time zone,
    "title" "text"
);


ALTER TABLE "public"."birthday_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cj_advertisers" (
    "advertiser_id" "text" NOT NULL,
    "advertiser_name" "text",
    "logo_url" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "program_url" "text"
);


ALTER TABLE "public"."cj_advertisers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cj_deals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cj_link_id" "text",
    "advertiser_id" "text" NOT NULL,
    "advertiser_name" "text",
    "title" "text" NOT NULL,
    "description" "text",
    "kind" "text" DEFAULT 'offer'::"text" NOT NULL,
    "voucher_code" "text",
    "terms" "text",
    "destination_url" "text" NOT NULL,
    "image_url" "text",
    "category" "text",
    "region" "text",
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cj_deals_kind_check" CHECK (("kind" = ANY (ARRAY['offer'::"text", 'voucher'::"text"])))
);


ALTER TABLE "public"."cj_deals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."market_listings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "price_pence" integer,
    "mode" "text" DEFAULT 'sell'::"text" NOT NULL,
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "locality" "text",
    "lat" double precision,
    "lng" double precision,
    "photo_urls" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'live'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "views" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "market_listings_description_check" CHECK (("char_length"("description") <= 2000)),
    CONSTRAINT "market_listings_mode_check" CHECK (("mode" = ANY (ARRAY['sell'::"text", 'swap'::"text", 'free'::"text"]))),
    CONSTRAINT "market_listings_price_pence_check" CHECK ((("price_pence" >= 0) AND ("price_pence" <= 100000000))),
    CONSTRAINT "market_listings_status_check" CHECK (("status" = ANY (ARRAY['live'::"text", 'sold'::"text", 'removed'::"text"]))),
    CONSTRAINT "market_listings_title_check" CHECK ((("char_length"("title") >= 3) AND ("char_length"("title") <= 120)))
);


ALTER TABLE "public"."market_listings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."moderation_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "reporter_id" "uuid",
    "detail" "text",
    "status" "public"."moderation_status" DEFAULT 'pending'::"public"."moderation_status" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."moderation_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity_id" "uuid"
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offer_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "offer_id" "uuid" NOT NULL,
    "profile_id" "uuid",
    "redeemed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."offer_redemptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offer_saves" (
    "offer_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."offer_saves" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "post_id" "uuid",
    "title" "text" NOT NULL,
    "details" "text",
    "code" "text",
    "starts_at" timestamp with time zone,
    "ends_at" timestamp with time zone,
    "max_redemptions" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "offer_type" "text",
    "discount_pct" numeric(4,1),
    "notify_followers" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."offers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "buyer_id" "uuid",
    "product_id" "uuid",
    "product_title" "text" NOT NULL,
    "product_kind" "text" NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    "amount_pence" integer NOT NULL,
    "application_fee_pence" integer DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'gbp'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "redeem_code" "text",
    "referrer_profile_id" "uuid",
    "stripe_checkout_session_id" "text",
    "stripe_payment_intent_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "orders_amount_pence_check" CHECK (("amount_pence" > 0)),
    CONSTRAINT "orders_application_fee_pence_check" CHECK (("application_fee_pence" >= 0)),
    CONSTRAINT "orders_product_kind_check" CHECK (("product_kind" = ANY (ARRAY['product'::"text", 'service'::"text"]))),
    CONSTRAINT "orders_quantity_check" CHECK ((("quantity" >= 1) AND ("quantity" <= 20))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'collected'::"text", 'redeemed'::"text", 'refunded'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_credit_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "delta" integer NOT NULL,
    "reason" "text" NOT NULL,
    "ref" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_credit_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "platform" "text" NOT NULL,
    "token" "text" NOT NULL,
    "consent" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."saved_transit_stops" (
    "profile_id" "uuid" NOT NULL,
    "stop_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "lat" double precision NOT NULL,
    "lng" double precision NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."saved_transit_stops" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shop_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "buyer_id" "uuid",
    "venue_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_pence" integer DEFAULT 0 NOT NULL,
    "currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."shop_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shop_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price_pence" integer,
    "currency" character(3) DEFAULT 'GBP'::"bpchar" NOT NULL,
    "media" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."shop_products" OWNER TO "postgres";


COMMENT ON TABLE "public"."shop_products" IS 'DORMANT Stage-5 seam (marketplace). Modelled now; gated by feature_flags.marketplace.enabled. Existence avoids a future migration.';


CREATE TABLE IF NOT EXISTS "public"."trip_stops" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "venue_id" "uuid",
    "label" "text",
    "geo" "public"."geography"(Point,4326),
    "position" integer DEFAULT 0 NOT NULL,
    "arrive_on" "date"
);


ALTER TABLE "public"."trip_stops" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trips" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "starts_on" "date",
    "ends_on" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."trips" OWNER TO "postgres";


COMMENT ON TABLE "public"."trips" IS 'DORMANT Stage-5 seam (travel). Modelled now; gated by feature_flags.travel.enabled.';


CREATE TABLE IF NOT EXISTS "public"."user_private" (
    "user_id" "uuid" NOT NULL,
    "birth_date" "date",
    "birthday_offers_enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "presence_alerts_enabled" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."user_private" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_birthday_offer" (
    "venue_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "title" "text",
    "details" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."venue_birthday_offer" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_marketing_prefs" (
    "venue_id" "uuid" NOT NULL,
    "suggestions_enabled" boolean DEFAULT false NOT NULL,
    "discount_cap_pct" integer,
    "offer_types" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "product_notes" "text",
    "onboarded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "venue_marketing_prefs_discount_cap_pct_check" CHECK ((("discount_cap_pct" IS NULL) OR (("discount_cap_pct" >= 0) AND ("discount_cap_pct" <= 50))))
);


ALTER TABLE "public"."venue_marketing_prefs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_payment_accounts" (
    "venue_id" "uuid" NOT NULL,
    "stripe_account_id" "text" NOT NULL,
    "charges_enabled" boolean DEFAULT false NOT NULL,
    "payouts_enabled" boolean DEFAULT false NOT NULL,
    "details_submitted" boolean DEFAULT false NOT NULL,
    "country" "text" DEFAULT 'GB'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."venue_payment_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venue_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "price_pence" integer NOT NULL,
    "currency" "text" DEFAULT 'gbp'::"text" NOT NULL,
    "stock" integer,
    "photo_url" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "venue_products_description_check" CHECK (("char_length"("description") <= 2000)),
    CONSTRAINT "venue_products_kind_check" CHECK (("kind" = ANY (ARRAY['product'::"text", 'service'::"text"]))),
    CONSTRAINT "venue_products_price_pence_check" CHECK ((("price_pence" >= 50) AND ("price_pence" <= 999900))),
    CONSTRAINT "venue_products_stock_check" CHECK (("stock" >= 0)),
    CONSTRAINT "venue_products_title_check" CHECK ((("char_length"("title") >= 3) AND ("char_length"("title") <= 120)))
);


ALTER TABLE "public"."venue_products" OWNER TO "postgres";
