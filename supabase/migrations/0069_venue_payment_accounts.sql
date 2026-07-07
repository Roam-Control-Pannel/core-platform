-- 0069_venue_payment_accounts.sql
--
-- Marketplace PR 1: Stripe Connect payout onboarding for claimed venues. One row per venue
-- holding its Stripe EXPRESS account id and the onboarding flags Stripe reports back
-- (charges_enabled / payouts_enabled / details_submitted). The flags are a CACHE of Stripe's
-- truth — refreshed on dashboard load after onboarding returns, and by the account.updated
-- webhook — so the dashboard can render payout status without a Stripe round-trip.
--
-- Money NEVER touches these rows: no balances, no card data, no payout amounts. The Stripe
-- account id is not a secret (it's an identifier, useless without our platform key), but it
-- is still owner-only to read.
--
-- Writes: none from clients. The API writes with the service role (the sanctioned in-process
-- escalation, same as posts.create) after verifying venue ownership — so there are no
-- insert/update RLS policies at all.
--
-- Idempotent; safe to run once on the Roam-Core project.

create table if not exists venue_payment_accounts (
  venue_id uuid primary key references venues(id) on delete cascade,
  stripe_account_id text not null unique,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  -- ISO 3166-1 alpha-2 of the connected account (Express accounts are country-fixed at creation).
  country text not null default 'GB',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table venue_payment_accounts enable row level security;

-- Owner-only read (the dashboard's payout status card).
drop policy if exists venue_payment_accounts_owner_read on venue_payment_accounts;
create policy venue_payment_accounts_owner_read on venue_payment_accounts
  for select
  using (
    exists (
      select 1 from venues v
      where v.id = venue_payment_accounts.venue_id
        and v.owner_id = auth.uid()
    )
  );

-- Keep updated_at honest on service-role updates (same trigger fn as 0001).
drop trigger if exists venue_payment_accounts_updated_at on venue_payment_accounts;
create trigger venue_payment_accounts_updated_at
  before update on venue_payment_accounts
  for each row execute function set_updated_at();
