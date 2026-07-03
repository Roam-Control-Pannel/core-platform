-- 0062_awin_deals.sql
-- Awin affiliate "deals": advertiser offers/vouchers ingested from the Awin Offers API (Retrieve
-- Offers), surfaced in-app as cards whose CTA is an Awin-tracked affiliate link. This migration is
-- just the store + read policy; ingestion (a later PR) upserts rows with the service role, which
-- bypasses RLS. Deals are PUBLIC marketing content — world-readable, like a venue's live offers.

create table if not exists public.awin_deals (
  id              uuid primary key default gen_random_uuid(),
  -- Awin's own promotion id, when ingested from the API — the upsert key (null for hand-seeded rows).
  awin_promotion_id text unique,
  advertiser_id   text not null,            -- Awin advertiser/merchant id (awinmid in the tracking link)
  advertiser_name text,
  title           text not null,
  description     text,
  kind            text not null default 'offer' check (kind in ('offer', 'voucher')),
  voucher_code    text,
  terms           text,
  destination_url text not null,            -- landing page the affiliate link deep-links to (ued=)
  image_url       text,
  category        text,
  region          text,                     -- optional locality tag for later geo-relevance; null = global
  starts_at       timestamptz,
  ends_at         timestamptz,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Read path: "live" deals first (active, within their date window), newest first.
create index if not exists awin_deals_live_idx
  on public.awin_deals (active, ends_at, created_at desc);

alter table public.awin_deals enable row level security;

-- Public read of LIVE deals only. No insert/update/delete policy: writes are service-role only
-- (the ingestion job), which bypasses RLS. Anonymous browsing sees deals (browse-freely contract).
drop policy if exists awin_deals_public_read on public.awin_deals;
create policy awin_deals_public_read on public.awin_deals
  for select
  using (
    active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at >= now())
  );
