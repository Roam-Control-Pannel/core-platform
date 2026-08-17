-- 0125_venue_reviews_read_own.sql
--
-- Harden review editing: let an author always SELECT their OWN review, regardless of moderation.
--
-- The 0085 SELECT policy (venue_reviews_read) is approval-scoped only:
--   using (moderation in ('auto_approved','approved'))
-- If a review is ever moved off approved by a moderation action, its author can no longer read it,
-- so `reviews.mine` returns null — the editor stops prefilling and the owner can't see/replace the
-- review they wrote. (Re-submit still works via the author-scoped UPDATE policy, but the UX reads as
-- "my review vanished".)
--
-- Add a second, permissive SELECT policy scoped to the author. Postgres OR-combines permissive
-- policies, so the public still sees only approved reviews (venue_reviews_read), while an author can
-- always see their own row (this policy). The public list RPC `venue_reviews_list` (0085) keeps its
-- own `moderation in (...)` WHERE filter, so a moderated-away review still never appears in the
-- public list — only in the author's own editor. Idempotent.

drop policy if exists venue_reviews_read_own on venue_reviews;
create policy venue_reviews_read_own on venue_reviews for select
  using (author_id = auth.uid());
