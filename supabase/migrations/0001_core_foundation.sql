-- ============================================================================
-- Roam pre-F2G baseline — Core foundation
-- Generated from the final schema at migration 0115; see migrations/README.md.
-- ============================================================================
SET statement_timeout = 0;


SET lock_timeout = 0;


SET idle_in_transaction_session_timeout = 0;


SET client_encoding = 'UTF8';


SET standard_conforming_strings = on;


SELECT pg_catalog.set_config('search_path', '', false);


SET check_function_bodies = false;


SET xmloption = content;


SET client_min_messages = warning;


SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';


CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";


CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";


CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";


CREATE EXTENSION IF NOT EXISTS "postgis" WITH SCHEMA "public";


CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";


CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";


CREATE TYPE "public"."friendship_status" AS ENUM (
    'pending',
    'accepted',
    'blocked'
);


ALTER TYPE "public"."friendship_status" OWNER TO "postgres";


CREATE TYPE "public"."moderation_status" AS ENUM (
    'pending',
    'auto_approved',
    'auto_flagged',
    'approved',
    'rejected'
);


ALTER TYPE "public"."moderation_status" OWNER TO "postgres";


CREATE TYPE "public"."post_destination" AS ENUM (
    'profile',
    'feed',
    'follower_push'
);


ALTER TYPE "public"."post_destination" OWNER TO "postgres";


CREATE TYPE "public"."post_kind" AS ENUM (
    'news',
    'offer',
    'event'
);


ALTER TYPE "public"."post_kind" OWNER TO "postgres";


CREATE TYPE "public"."presence_availability" AS ENUM (
    'free_to_meet',
    'out_and_about',
    'heads_down'
);


ALTER TYPE "public"."presence_availability" OWNER TO "postgres";


CREATE TYPE "public"."subscription_tier" AS ENUM (
    'free',
    'premium',
    'gold'
);


ALTER TYPE "public"."subscription_tier" OWNER TO "postgres";


CREATE TYPE "public"."venue_status" AS ENUM (
    'unclaimed',
    'pending_claim',
    'claimed',
    'suspended'
);


ALTER TYPE "public"."venue_status" OWNER TO "postgres";


CREATE TYPE "public"."venue_claim_approval" AS (
	"claim_id" "uuid",
	"venue_id" "uuid",
	"verified" boolean,
	"venue_status" "public"."venue_status",
	"method" "text"
);


ALTER TYPE "public"."venue_claim_approval" OWNER TO "postgres";


CREATE TYPE "public"."venue_claim_status" AS ENUM (
    'pending',
    'approved',
    'rejected'
);


ALTER TYPE "public"."venue_claim_status" OWNER TO "postgres";


SET default_tablespace = '';


SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."feature_flags" (
    "key" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."feature_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "handle" "text" NOT NULL,
    "display_name" "text",
    "avatar_url" "text",
    "header_url" "text",
    "bio" "text",
    "home_geo" "public"."geography"(Point,4326),
    "social_links" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "banned_at" timestamp with time zone,
    "home_layout" "jsonb",
    "place_prefs" "jsonb",
    "home_locality" "text",
    "verified_local" boolean DEFAULT false NOT NULL,
    "wall_view_count" integer DEFAULT 0 NOT NULL,
    "invited_by" "uuid",
    CONSTRAINT "profiles_handle_format" CHECK (("handle" ~ '^[a-z0-9_]{3,30}$'::"text"))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."banned_at" IS 'Set when a profile is banned by moderation; null = active. Banned users cannot claim venues; their claimed venues are suspended. Broader write-enforcement extends from here.';


COMMENT ON COLUMN "public"."profiles"."home_locality" IS 'The member''s home town (user-set) — the profile locality chip + "Lives in" line.';


COMMENT ON COLUMN "public"."profiles"."verified_local" IS 'Admin/verification-granted "verified local" badge. Default false — never asserted by default.';


COMMENT ON COLUMN "public"."profiles"."wall_view_count" IS 'Profile (wall) view tally, bumped by record_profile_view; shown as the "Wall views" stat.';


COMMENT ON COLUMN "public"."profiles"."invited_by" IS 'The profile whose invite link brought this user in (referral attribution; set once at signup via social.applyInvite). Mirrors orders.referrer_profile_id — captured from day one, rewards later.';
