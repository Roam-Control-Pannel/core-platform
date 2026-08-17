-- 0127_venue_reviews_list_stable_order.sql
--
-- Make the paged reviews list a STABLE total order. venue_reviews_list (0085) ordered by
-- `created_at desc` alone, which is not a total order: two reviews sharing a created_at have no
-- defined relative position, so Postgres may order them differently for offset 0 vs offset 20.
-- With the dashboard's new "Show more" offset paging, a tie straddling a page boundary can drop a
-- row from every page (silently missing) or surface it twice. Add `id desc` as a deterministic
-- tiebreaker so every row lands on exactly one page.
--
-- Only the ORDER BY changes; signature, columns, filter, and grants are identical to 0085.
-- create-or-replace, idempotent.

create or replace function venue_reviews_list(
  venue_id_param uuid,
  max_results    integer default 20,
  page_offset    integer default 0
)
returns table (
  id            uuid,
  rating        integer,
  body          text,
  created_at    timestamptz,
  updated_at    timestamptz,
  author_id     uuid,
  author_name   text,
  author_handle text,
  author_avatar text
)
language sql
stable
security invoker
set search_path = public
as $$
  select r.id, r.rating, r.body, r.created_at, r.updated_at,
         r.author_id, p.display_name, p.handle, p.avatar_url
  from venue_reviews r
  join profiles p on p.id = r.author_id
  where r.venue_id = venue_id_param
    and r.moderation in ('auto_approved', 'approved')
  order by r.created_at desc, r.id desc
  limit greatest(1, least(coalesce(max_results, 20), 50))
  offset greatest(0, coalesce(page_offset, 0));
$$;

grant execute on function venue_reviews_list(uuid, integer, integer) to anon, authenticated;
