-- ============================================================================
-- Roam — 0109_cj_deals.sql
-- CJ (Commission Junction) affiliate "deals": promotional links ingested from the
-- CJ Link Search API (link-search.api.cj.com/v2/link-search) into cj_deals, and
-- surfaced through the SAME public Deals surface as Awin (deals router unions the
-- two networks). A parallel store — not a column on awin_deals — so each network's
-- ingestion + retire logic stays fully independent and the working Awin path is
-- untouched.
--
-- Mirrors awin_deals (0062) field-for-field, with two differences:
--   * cj_link_id (CJ's link-id) is the upsert key, not awin_promotion_id.
--   * destination_url stores CJ's clickUrl, which is ALREADY tracking-wrapped (the
--     publisher/website id is baked in by CJ) — so the web renders it verbatim and
--     never Awin-wraps it (see network dispatch in apps/web/src/lib/dealLink.ts).
--
-- Deals are PUBLIC marketing content — world-readable live rows, like awin_deals.
-- Writes are service-role only (the sync job bypasses RLS). Additive + idempotent.
-- ============================================================================

create table if not exists public.cj_deals (
  id              uuid primary key default gen_random_uuid(),
  -- CJ's own link id, when ingested from the API — the upsert key (null for hand-seeded rows).
  cj_link_id      text unique,
  advertiser_id   text not null,            -- CJ advertiser (CID) id
  advertiser_name text,
  title           text not null,
  description     text,
  kind            text not null default 'offer' check (kind in ('offer', 'voucher')),
  voucher_code    text,
  terms           text,
  destination_url text not null,            -- CJ clickUrl — ALREADY affiliate-tracked (never re-wrap)
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
create index if not exists cj_deals_live_idx
  on public.cj_deals (active, ends_at, created_at desc);

alter table public.cj_deals enable row level security;

-- Public read of LIVE deals only. No insert/update/delete policy: writes are service-role only
-- (the ingestion job), which bypasses RLS. Anonymous browsing sees deals (browse-freely contract).
drop policy if exists cj_deals_public_read on public.cj_deals;
create policy cj_deals_public_read on public.cj_deals
  for select
  using (
    active
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at >= now())
  );
