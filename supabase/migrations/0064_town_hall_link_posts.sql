-- 0064_town_hall_link_posts.sql
-- Link posts for Town Hall — a topic may carry a URL (Reddit's "link post"). The link metadata
-- (domain, title, image) is unfurled SERVER-SIDE at post time and stored here, so the client never
-- supplies the image URL (which would let anyone inject arbitrary/tracking images). All nullable:
-- a link that can't be unfurled still posts, just without a thumbnail; a plain text topic has none.

alter table public.town_hall_topics
  add column if not exists link_url       text,
  add column if not exists link_domain    text,
  add column if not exists link_title     text,
  add column if not exists link_image_url text;
