-- 0088_profile_post_location.sql
--
-- "Check in" for wall posts: an optional free-text place a post is tagged to (e.g. "Babul's,
-- Newcastle"). It's a plain label the author types in the composer — not a venue FK — so a check-in
-- can name anywhere, and existing posts simply carry NULL.
--
--   location — the checked-in place shown under the post's timestamp. NULL = no check-in.

alter table profile_posts
  add column if not exists location text;

comment on column profile_posts.location is 'Optional free-text "checked in at" place shown under a wall post. NULL = no check-in.';
