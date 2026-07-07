-- 0073_listing_views.sql
--
-- Marketplace UX C: view counts for C2C listings — the seller's "is anyone seeing this?"
-- signal. One integer per listing (no viewer identity, ever); incremented by the public
-- listing page through a definer RPC (clients have no UPDATE path to the counter — the
-- owner-write policy covers their own rows, but the counter must move for ANY viewer).
-- Idempotent; run once.

alter table market_listings add column if not exists views integer not null default 0;

create or replace function record_listing_view(p_listing uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update market_listings set views = views + 1 where id = p_listing and status = 'live';
$$;

grant execute on function record_listing_view(uuid) to anon, authenticated;
