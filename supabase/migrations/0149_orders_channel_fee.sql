-- ============================================================================
-- 0149 — Orders carry the channel they belong to; the platform fee is per channel.
--
-- WHY. The Food to Go storefront (channel 'f2g') charges a 7% platform fee; Roam's default is 5%.
-- Until now the fee was one global env value (PLATFORM_FEE_BPS) and an order recorded no channel at
-- all, so (a) the F2G hero's copy and the fee taken could never agree, and (b) F2G order volume,
-- value and fees were unreportable — now or ever (an order placed a month ago cannot be told apart
-- from a Roam one). Holistic plan Phase 1.1 (docs/f2g-holistic-plan.md).
--
-- WHAT.
--   channels.platform_fee_bps   — the commission a channel's orders carry, in basis points.
--                                 Seeded: roam 500 (today's default), f2g 700 (decision D5).
--   orders.channel_id           — the channel an order belongs to. Stamped at checkout from now
--                                 on; NULL for every order that predates this migration (never
--                                 backfilled — we don't know, so we don't guess).
--   order_channel_for_venue()   — the ONE rule for "which channel does this venue's order belong
--                                 to", decided SERVER-SIDE from the venue, never from the client's
--                                 x-roam-channel hint (a hint the browser can set to whatever it
--                                 likes, and the fee is money):
--                                   1. a non-default channel where the venue is a roster member
--                                      (channel_members claimed/live — the same set 0145's ranking
--                                      treats as members), else
--                                   2. a non-default channel the venue is tagged into
--                                      (venue_channels), else
--                                   3. the default channel (roam).
--                                 A venue that is an F2G member is an F2G venue for every order it
--                                 takes, wherever the buyer happened to browse: the Association's
--                                 7% is the venue's deal with the Association, not a per-visit
--                                 choice. SECURITY DEFINER (it must read the RLS-locked roster) and
--                                 SERVICE-ONLY: the API calls it with the service client; clients
--                                 get nothing (the fee is not theirs to look up).
--
-- Idempotent. Forward-only. Phase 2 of the plan tightens rule 1 to status='live' + a role on the
-- venue tag; the function is the single place that will change.
-- ============================================================================

-- ── channels.platform_fee_bps ───────────────────────────────────────────────────────────────────
alter table channels
  add column if not exists platform_fee_bps integer not null default 500;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channels_platform_fee_bps_check') then
    alter table channels
      add constraint channels_platform_fee_bps_check check (platform_fee_bps between 0 and 3000);
  end if;
end $$;

comment on column channels.platform_fee_bps is
  'Platform commission on this channel''s orders, in basis points (700 = 7%). Applied to the goods '
  'subtotal only (delivery charges go to the venue in full). Read at checkout via '
  'order_channel_for_venue(); the env PLATFORM_FEE_BPS is only the fallback when no channel resolves.';

update channels set platform_fee_bps = 700 where key = 'f2g';
update channels set platform_fee_bps = 500 where key = 'roam';

-- ── orders.channel_id ───────────────────────────────────────────────────────────────────────────
alter table orders
  add column if not exists channel_id uuid references channels(id) on delete set null;

create index if not exists orders_channel_idx on orders (channel_id, created_at desc);

comment on column orders.channel_id is
  'The channel this order belongs to (decided server-side at checkout by order_channel_for_venue). '
  'NULL = placed before 0149; never backfilled. Roam orders carry the default channel''s id, so '
  'per-channel reporting is a plain GROUP BY.';

-- ── order_channel_for_venue ─────────────────────────────────────────────────────────────────────
drop function if exists public.order_channel_for_venue(uuid);

create function public.order_channel_for_venue(p_venue_id uuid)
returns table (channel_id uuid, channel_key text, platform_fee_bps integer)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    -- 1. roster member of a non-default channel
    select c.id, c.key, c.platform_fee_bps, 1 as tier
      from channels c
      join channel_members m on m.channel_id = c.id
     where m.venue_id = p_venue_id
       and m.status in ('claimed', 'live')
       and c.active and not c.is_default
    union all
    -- 2. tagged into a non-default channel
    select c.id, c.key, c.platform_fee_bps, 2
      from channels c
      join venue_channels vc on vc.channel_id = c.id
     where vc.venue_id = p_venue_id
       and c.active and not c.is_default
    union all
    -- 3. the default channel
    select c.id, c.key, c.platform_fee_bps, 3
      from channels c
     where c.is_default
  )
  select id, key, platform_fee_bps
    from candidates
   order by tier, key
   limit 1;
$$;

comment on function public.order_channel_for_venue(uuid) is
  'Which channel a venue''s orders belong to, and that channel''s platform fee: roster member of a '
  'non-default channel → tagged into one → the default channel. Server-side truth for checkout; '
  'never derived from the client''s x-roam-channel hint. SECURITY DEFINER (reads the RLS-locked '
  'roster) and service-only.';

-- Supabase's default privileges grant EXECUTE on public functions DIRECTLY to anon/authenticated,
-- which a `from public` revoke does not touch — revoke from the client roles explicitly.
revoke all on function public.order_channel_for_venue(uuid) from public;
revoke execute on function public.order_channel_for_venue(uuid) from anon, authenticated;
grant execute on function public.order_channel_for_venue(uuid) to service_role;
