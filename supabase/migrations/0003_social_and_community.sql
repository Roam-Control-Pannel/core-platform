-- ============================================================================
-- Roam pre-F2G baseline — Social and community
-- Generated from the final schema at migration 0115; see migrations/README.md.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "public"."chat_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_group" boolean DEFAULT false NOT NULL,
    "plan_id" "uuid",
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image_path" "text"
);


ALTER TABLE "public"."chat_threads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."chat_threads"."image_path" IS 'Optional custom group-photo object path in the chat-media bucket (thread_id/<uuid>.<ext>). NULL → UI shows a member-avatar composite.';


CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "sender_id" "uuid",
    "body" "text",
    "kind" "text" DEFAULT 'text'::"text" NOT NULL,
    "payload" "jsonb",
    "moderation" "public"."moderation_status" DEFAULT 'pending'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_participants" (
    "thread_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "last_read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chat_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_poll_votes" (
    "message_id" "uuid" NOT NULL,
    "option_id" "text" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."chat_poll_votes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_polls" (
    "message_id" "uuid" NOT NULL,
    "closed_at" timestamp with time zone,
    "closed_by" "uuid"
);


ALTER TABLE "public"."chat_polls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_interest" (
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_interest" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "author_id" "uuid",
    "locality" "text" NOT NULL,
    "locality_label" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "category" "text",
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone,
    "venue_id" "uuid",
    "location_name" "text",
    "lat" double precision,
    "lng" double precision,
    "geo" "public"."geography"(Point,4326),
    "url" "text",
    "cover_image_url" "text",
    "interested_count" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'published'::"text" NOT NULL,
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "events_category_ok" CHECK ((("category" IS NULL) OR ("category" = ANY (ARRAY['music'::"text", 'nightlife'::"text", 'food_drink'::"text", 'arts_culture'::"text", 'sports_fitness'::"text", 'community'::"text", 'market_fair'::"text", 'family'::"text", 'learning'::"text", 'other'::"text"])))),
    CONSTRAINT "events_desc_len" CHECK ((("description" IS NULL) OR ("char_length"("description") <= 8000))),
    CONSTRAINT "events_locname_len" CHECK ((("location_name" IS NULL) OR ("char_length"("location_name") <= 200))),
    CONSTRAINT "events_status_ok" CHECK (("status" = ANY (ARRAY['published'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "events_time_order" CHECK ((("ends_at" IS NULL) OR ("ends_at" >= "starts_at"))),
    CONSTRAINT "events_title_len" CHECK ((("char_length"("title") >= 1) AND ("char_length"("title") <= 140))),
    CONSTRAINT "events_url_len" CHECK ((("url" IS NULL) OR ("char_length"("url") <= 2000)))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."follows" (
    "follower_id" "uuid" NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "push_enabled" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."follows" OWNER TO "postgres";


COMMENT ON COLUMN "public"."follows"."push_enabled" IS 'When false, follower still follows the venue but is excluded from follower_push fan-out.';


CREATE TABLE IF NOT EXISTS "public"."friend_presence" (
    "profile_id" "uuid" NOT NULL,
    "availability" "public"."presence_availability",
    "note" "text",
    "expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "geo" "public"."geography"(Point,4326),
    "geo_accuracy_m" double precision,
    "geo_expires_at" timestamp with time zone,
    CONSTRAINT "friend_presence_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 280)))
);


ALTER TABLE "public"."friend_presence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."friendships" (
    "requester_id" "uuid" NOT NULL,
    "addressee_id" "uuid" NOT NULL,
    "status" "public"."friendship_status" DEFAULT 'pending'::"public"."friendship_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "friendships_check" CHECK (("requester_id" <> "addressee_id"))
);


ALTER TABLE "public"."friendships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetup_locations" (
    "meetup_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "geo" "public"."geography"(Point,4326) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."meetup_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetup_options" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meetup_id" "uuid" NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "added_by" "uuid"
);


ALTER TABLE "public"."meetup_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetup_votes" (
    "meetup_id" "uuid" NOT NULL,
    "option_id" "uuid" NOT NULL,
    "voter_id" "uuid" NOT NULL,
    "voted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."meetup_votes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meetups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "started_by" "uuid",
    "state" "text" DEFAULT 'voting'::"text" NOT NULL,
    "resolved_venue_id" "uuid",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "ended_at" timestamp with time zone
);


ALTER TABLE "public"."meetups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plan_members" (
    "plan_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "accepted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."plan_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plan_venues" (
    "plan_id" "uuid" NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "added_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."plan_venues" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "notes" "text",
    "planned_for" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "header_url" "text"
);


ALTER TABLE "public"."plans" OWNER TO "postgres";


COMMENT ON COLUMN "public"."plans"."header_url" IS 'Public URL of the plan''s custom header image (profile-media bucket, owner folder). Null = default gradient. API validates http(s).';


CREATE TABLE IF NOT EXISTS "public"."posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "venue_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "kind" "public"."post_kind" NOT NULL,
    "title" "text",
    "body" "text",
    "media" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "destinations" "public"."post_destination"[] DEFAULT '{profile}'::"public"."post_destination"[] NOT NULL,
    "is_draft" boolean DEFAULT false NOT NULL,
    "publish_at" timestamp with time zone,
    "published_at" timestamp with time zone,
    "moderation" "public"."moderation_status" DEFAULT 'pending'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "like_count" integer DEFAULT 0 NOT NULL,
    "comment_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."posts_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "body" "text" NOT NULL,
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "posts_comments_body_len" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 3000)))
);


ALTER TABLE "public"."posts_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."posts_likes" (
    "post_id" "uuid" NOT NULL,
    "liker_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."posts_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."presence_alerts" (
    "from_id" "uuid" NOT NULL,
    "to_id" "uuid" NOT NULL,
    "alerted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."presence_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_post_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "body" "text" NOT NULL,
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profile_post_comments_body_len" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 3000)))
);


ALTER TABLE "public"."profile_post_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_post_likes" (
    "post_id" "uuid" NOT NULL,
    "liker_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profile_post_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "author_id" "uuid" NOT NULL,
    "body" "text",
    "media" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "like_count" integer DEFAULT 0 NOT NULL,
    "comment_count" integer DEFAULT 0 NOT NULL,
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "location" "text",
    CONSTRAINT "profile_posts_body_len" CHECK ((("body" IS NULL) OR ("char_length"("body") <= 5000))),
    CONSTRAINT "profile_posts_not_empty" CHECK (((("body" IS NOT NULL) AND ("char_length"("btrim"("body")) > 0)) OR ("jsonb_array_length"("media") > 0)))
);


ALTER TABLE "public"."profile_posts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profile_posts"."location" IS 'Optional free-text "checked in at" place shown under a wall post. NULL = no check-in.';


CREATE TABLE IF NOT EXISTS "public"."town_hall_replies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "topic_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "body" "text" NOT NULL,
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "upvote_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "town_hall_replies_body_len" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 8000)))
);


ALTER TABLE "public"."town_hall_replies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."town_hall_reply_votes" (
    "reply_id" "uuid" NOT NULL,
    "voter_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."town_hall_reply_votes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."town_hall_topics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "locality" "text" NOT NULL,
    "locality_label" "text" NOT NULL,
    "author_id" "uuid",
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "upvote_count" integer DEFAULT 0 NOT NULL,
    "reply_count" integer DEFAULT 0 NOT NULL,
    "last_activity_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "moderation" "public"."moderation_status" DEFAULT 'auto_approved'::"public"."moderation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slug" "text" NOT NULL,
    "link_url" "text",
    "link_domain" "text",
    "link_title" "text",
    "link_image_url" "text",
    "category" "text",
    CONSTRAINT "town_hall_topics_body_len" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 8000))),
    CONSTRAINT "town_hall_topics_title_len" CHECK ((("char_length"("title") >= 1) AND ("char_length"("title") <= 140)))
);


ALTER TABLE "public"."town_hall_topics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."town_hall_votes" (
    "topic_id" "uuid" NOT NULL,
    "voter_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."town_hall_votes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_blocks" (
    "blocker_id" "uuid" NOT NULL,
    "blocked_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_blocks_check" CHECK (("blocker_id" <> "blocked_id"))
);


ALTER TABLE "public"."user_blocks" OWNER TO "postgres";
