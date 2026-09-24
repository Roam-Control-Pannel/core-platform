-- ============================================================================
-- 0157 — the Association portal's aggregates (F2G plan 3.2).
--
-- Everything the partner's overview screen shows, as channel-scoped RPCs. Four functions, one
-- shape of protection.
--
-- THE GATE IS IN THE FUNCTION, NOT ONLY IN THE API. `associationProcedure` (0156) already resolves
-- the caller's channel and refuses the rest — but these are PostgREST-reachable RPCs, so a signed-in
-- user can call them directly with any channel id they like, without going near the API's gate. Each
-- one therefore re-asks `is_channel_admin(p_channel_id)` itself and returns nothing if the answer is
-- no. That is why 0156 defined that predicate once: it is asked here, in 3.4's RLS, and in the API,
-- and all three must agree or a partner reads another partner's numbers.
--
-- SECURITY DEFINER because they read `channel_members`, which is service-managed (RLS on, no client
-- policy). The definer rights are what make the read possible; `is_channel_admin` is what makes it
-- legitimate. Neither alone is sufficient, and the pgTAP suite proves the combination.
--
-- WHAT IS DELIBERATELY NOT HERE. No customer, buyer or order-line data — decision 5.3 chose Option B
-- (channel totals plus per-member-venue totals, nothing below that), and these signatures cannot
-- express anything finer even if a future caller wanted it. No member e-mail or contact column: the
-- members LIST is 3.3's job and carries 2.5's masking rules; this file is counts and money only.
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

-- ── 1. the overview tiles ────────────────────────────────────────────────────────────────────────
-- One row, because the overview screen renders one screenful. Returning it as a single row rather
-- than six round trips also means every tile is computed from the same snapshot — a funnel whose
-- "live" and "total" came from different instants is a support ticket waiting to happen.
create or replace function public.channel_portal_overview(p_channel_id uuid)
returns table (
  members_total      integer,
  members_imported   integer,
  members_invited    integer,
  members_claimed    integer,
  members_live       integer,
  members_lapsed     integer,
  members_removed    integer,
  -- Non-members that opted their venue into the storefront (venue_channels.role = 'listed', 0154).
  -- Listed, never ranked or badged as members — so they are counted apart from the funnel above.
  listed_non_members integer,
  -- Of the channel's member venues, how many carry a DISPLAYABLE FSA rating ('0'..'5'). A
  -- non-numeric status (AwaitingInspection, Exempt) is not a rating and is not counted as one.
  member_venues      integer,
  member_venues_rated integer,
  jobs_open          integer,
  jobs_total         integer,
  suppliers_approved integer,
  suppliers_pending  integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with allowed as (select public.is_channel_admin(p_channel_id) as ok),
  member_venue as (
    select venue_id from public.f2g_member_venue_ids(p_channel_id)
  ),
  rated as (
    select count(*) filter (where fe.rating_value ~ '^[0-5]$') as n_rated,
           count(*) as n_total
      from member_venue mv
      left join external_refs fer
        on fer.entity_type = 'venue' and fer.entity_id = mv.venue_id and fer.dataset = 'fsa'
      left join fsa_establishments fe on fe.fhrsid = fer.external_id
  ),
  -- Suppliers are NOT channel-scoped in the schema (orgs has no channel_id; creation is gated by
  -- f2g_can_post_supplier). A global count would show this partner another partner's numbers, so
  -- scope it the only honest way: suppliers owned by someone who claimed a membership here.
  sup as (
    select
      count(*) filter (where o.status = 'live' and o.moderation in ('auto_approved', 'approved')) as approved,
      count(*) filter (where o.moderation = 'pending') as pending
      from orgs o
     where o.owner_id in (
       select cm.claimed_by from channel_members cm
        where cm.channel_id = p_channel_id and cm.claimed_by is not null
     )
  )
  select
    (select count(*)::int from channel_members where channel_id = p_channel_id),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'imported'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'invited'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'claimed'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'live'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'lapsed'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'removed'),
    (select count(*)::int from venue_channels where channel_id = p_channel_id and role = 'listed'),
    (select n_total::int from rated),
    (select n_rated::int from rated),
    (select count(*)::int from job_posts
      where channel_id = p_channel_id and status = 'published'
        and (expires_at is null or expires_at > now())),
    (select count(*)::int from job_posts where channel_id = p_channel_id),
    (select approved::int from sup),
    (select pending::int from sup)
  from allowed where allowed.ok;   -- not an admin of this channel → zero rows, not zeroed counts
$$;

-- ── 2. members by council ────────────────────────────────────────────────────────────────────────
-- Council of record is the FSA register's local_authority for the matched venue, with the roster's
-- own column taking precedence where the Association supplied one — the same coalesce 0154's
-- directory search uses, because two places disagreeing about which council a member is in is
-- exactly the drift this project keeps designing against.
create or replace function public.channel_portal_members_by_council(p_channel_id uuid)
returns table (council text, members integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(m.source_council, fe.local_authority, 'Unknown') as council,
         count(*)::int as members
    from channel_members m
    join venues v on v.id = m.venue_id
    left join external_refs fer
      on fer.entity_type = 'venue' and fer.entity_id = v.id and fer.dataset = 'fsa'
    left join fsa_establishments fe on fe.fhrsid = fer.external_id
   where m.channel_id = p_channel_id
     and m.status = 'live'
     and public.is_channel_admin(p_channel_id)
   group by 1
   order by 2 desc, 1;
$$;

-- ── 3. orders: the channel's totals for a period ─────────────────────────────────────────────────
-- Decision 5.3 Option B. `paid` and everything downstream of it counts as a sale; `pending` is an
-- abandoned checkout and `canceled` never happened, so neither belongs in GMV. Refunds are counted
-- separately rather than silently netted off, because "how much did we refund" is a question an
-- association will ask and a netted number cannot answer.
create or replace function public.channel_portal_orders(
  p_channel_id uuid,
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  orders_count   integer,
  gmv_pence      bigint,
  fees_pence     bigint,
  refunded_count integer,
  currency       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- The LEFT JOIN + `group by a.ok` is what makes a refusal look like a refusal. A bare aggregate
  -- with no GROUP BY returns one row of zeros however the WHERE clause turns out, so a non-admin
  -- would get "0 orders, £0" — indistinguishable from a real quiet week, and inconsistent with the
  -- other three functions here, which return no rows. Grouping on the gate makes an empty input
  -- produce an empty result.
  with allowed as (select public.is_channel_admin(p_channel_id) as ok)
  select
    count(o.id) filter (where o.status in ('paid', 'collected', 'redeemed'))::int,
    coalesce(sum(o.amount_pence + coalesce(o.delivery_fee_pence, 0))
             filter (where o.status in ('paid', 'collected', 'redeemed')), 0)::bigint,
    coalesce(sum(o.application_fee_pence)
             filter (where o.status in ('paid', 'collected', 'redeemed')), 0)::bigint,
    count(o.id) filter (where o.status = 'refunded')::int,
    -- One channel trades in one currency today; min() makes that explicit rather than picking a row
    -- at random, and a mixed-currency channel would show the anomaly instead of hiding it.
    min(o.currency)
    from allowed a
    left join orders o
      on o.channel_id = p_channel_id
     and (p_from is null or o.created_at >= p_from)
     and (p_to   is null or o.created_at <  p_to)
   where a.ok
   group by a.ok;
$$;

-- ── 4. orders per member venue ───────────────────────────────────────────────────────────────────
-- The half of Option B that makes the portal worth opening: what the storefront actually did for
-- each member. Venue name and totals only — no buyer, no line items, no times.
create or replace function public.channel_portal_orders_by_venue(
  p_channel_id uuid,
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns table (
  venue_id     uuid,
  venue_name   text,
  orders_count integer,
  gmv_pence    bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.id, v.name,
         count(*)::int,
         coalesce(sum(o.amount_pence + coalesce(o.delivery_fee_pence, 0)), 0)::bigint
    from orders o
    join venues v on v.id = o.venue_id
   where o.channel_id = p_channel_id
     and o.status in ('paid', 'collected', 'redeemed')
     and (p_from is null or o.created_at >= p_from)
     and (p_to   is null or o.created_at <  p_to)
     and public.is_channel_admin(p_channel_id)
   group by v.id, v.name
   order by 4 desc, 2;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────────────────────────
-- `authenticated` only: an anonymous caller has no appointment to check, and these read
-- service-managed data. The gate inside each function is what actually decides.
revoke all on function public.channel_portal_overview(uuid) from public, anon;
revoke all on function public.channel_portal_members_by_council(uuid) from public, anon;
revoke all on function public.channel_portal_orders(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.channel_portal_orders_by_venue(uuid, timestamptz, timestamptz) from public, anon;

grant execute on function public.channel_portal_overview(uuid) to authenticated;
grant execute on function public.channel_portal_members_by_council(uuid) to authenticated;
grant execute on function public.channel_portal_orders(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.channel_portal_orders_by_venue(uuid, timestamptz, timestamptz) to authenticated;

comment on function public.channel_portal_overview(uuid) is
  'Association portal overview tiles for ONE channel: membership funnel, listed non-members, member '
  'venues and how many carry a displayable FSA rating, jobs, and suppliers owned by this channel''s '
  'members. Returns NO ROWS unless is_channel_admin(p_channel_id) — the gate lives here because the '
  'RPC is reachable directly, not only through the API.';
comment on function public.channel_portal_orders(uuid, timestamptz, timestamptz) is
  'Channel order totals for a period (decision 5.3, Option B): count, GMV, platform fees, refunds. '
  'No buyer or line-item data — the signature cannot express it. Gated by is_channel_admin.';
comment on function public.channel_portal_orders_by_venue(uuid, timestamptz, timestamptz) is
  'Per-member-venue order totals for a period (decision 5.3, Option B). Venue name and totals only. '
  'Gated by is_channel_admin.';
