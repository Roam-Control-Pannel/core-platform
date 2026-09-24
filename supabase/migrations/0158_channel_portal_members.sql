-- ============================================================================
-- 0158 — the Association portal's members list (F2G plan 3.3).
--
-- DECISION 5.2, OPTION A, ENFORCED BY SHAPE. Officers see business, venue, council, membership
-- number and status. They do NOT see a member's personal e-mail or phone — the Association already
-- holds those, so the portal has no reason to hand them back, and Option B (roster e-mail with every
-- read audited) was rejected for v1.
--
-- That is why `source_email` and `source_phone` are not columns of this function rather than columns
-- this function happens not to select. A future edit cannot expose them by adding a field to a
-- select list; it would have to change the signature, which is a visible act with a review attached.
-- The same reasoning as 0157's order functions, which cannot express a buyer or a line item.
--
-- Gated by `is_channel_admin` for the same reason as 0157: PostgREST-reachable, so the API's gate is
-- not the only thing between a caller and this data.
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

create or replace function public.channel_portal_members(
  p_channel_id uuid,
  p_status     text    default null,
  p_council    text    default null,
  p_query      text    default null,
  p_limit      integer default 50,
  p_offset     integer default 0
)
returns table (
  member_id     uuid,
  business      text,
  member_no     text,
  venue_id      uuid,
  venue_name    text,
  venue_slug    text,
  council       text,
  status        text,
  -- When the member activated: the moment someone claimed this roster row. Null until they do.
  activated_at  timestamptz,
  -- Total matching rows, repeated on every row so the UI can page without a second count query
  -- that could disagree with the page it is labelling.
  total_count   integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with filtered as (
    select
      m.id, m.source_name, m.member_no, m.venue_id,
      v.name as venue_name, v.slug as venue_slug,
      -- Council of record: the roster's own column where the Association supplied one, else the FSA
      -- register's local_authority for the matched venue. The same coalesce as 0154 and 0157.
      coalesce(m.source_council, fe.local_authority) as council,
      m.status, m.claimed_at
      from channel_members m
      left join venues v on v.id = m.venue_id
      left join external_refs fer
        on fer.entity_type = 'venue' and fer.entity_id = m.venue_id and fer.dataset = 'fsa'
      left join fsa_establishments fe on fe.fhrsid = fer.external_id
     where m.channel_id = p_channel_id
       and public.is_channel_admin(p_channel_id)
       and (p_status  is null or m.status = p_status)
       and (p_council is null or coalesce(m.source_council, fe.local_authority) = p_council)
       -- The escaping matters: a member called "100% Bakery" must not turn into a wildcard search.
       and (p_query is null or m.source_name ilike
              '%' || replace(replace(p_query, '\', '\\'), '%', '\%') || '%')
  )
  select
    f.id, f.source_name, f.member_no, f.venue_id, f.venue_name, f.venue_slug,
    f.council, f.status, f.claimed_at,
    count(*) over ()::int
    from filtered f
   order by f.source_name
   limit greatest(1, least(coalesce(p_limit, 50), 500))
  offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.channel_portal_members(uuid, text, text, text, integer, integer)
  from public, anon;
grant execute on function public.channel_portal_members(uuid, text, text, text, integer, integer)
  to authenticated;

comment on function public.channel_portal_members(uuid, text, text, text, integer, integer) is
  'The Association portal''s members list for ONE channel: business, membership number, matched venue, '
  'council, status and activation date. Decision 5.2 Option A — a member''s personal e-mail and phone '
  'are NOT columns of this function, so they cannot be exposed by editing a select list. Gated by '
  'is_channel_admin; returns no rows for a caller with no appointment.';
