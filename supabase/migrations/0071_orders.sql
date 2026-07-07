-- 0071_orders.sql
--
-- Marketplace PR 3: orders. One row per checkout — a SNAPSHOT of what was bought (title,
-- kind, pence) so deleting/renaming a product never rewrites purchase history. Money truth
-- lives in Stripe; this table records what/who/state, plus the ids to reach Stripe objects.
--
-- Status flow: pending (checkout session created) → paid (webhook) → collected (product
-- picked up) / redeemed (voucher used in-venue) / refunded. canceled = never paid.
--
-- redeem_code: minted at order creation for service/voucher purchases; shown to the buyer
-- once PAID; the venue marks it redeemed in-venue.
--
-- referrer_profile_id: the affiliate seam — who drove this sale. Nullable, populated when
-- a referral link is involved; rewards logic comes later, attribution is captured from day one.
--
-- RLS: the buyer reads their own orders; the venue owner reads their venue's orders. NO
-- client writes at all — every state change goes through the API (service role) so the
-- Stripe webhook and owner actions are the only writers. Idempotent; run once.

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  buyer_id uuid references profiles(id) on delete set null,
  product_id uuid references venue_products(id) on delete set null,
  product_title text not null,
  product_kind text not null check (product_kind in ('product', 'service')),
  quantity integer not null default 1 check (quantity between 1 and 20),
  amount_pence integer not null check (amount_pence > 0),
  application_fee_pence integer not null default 0 check (application_fee_pence >= 0),
  currency text not null default 'gbp',
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'collected', 'redeemed', 'refunded', 'canceled')),
  redeem_code text unique,
  referrer_profile_id uuid references profiles(id) on delete set null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_venue_idx on orders (venue_id, created_at desc);
create index if not exists orders_buyer_idx on orders (buyer_id, created_at desc);

alter table orders enable row level security;

drop policy if exists orders_buyer_read on orders;
create policy orders_buyer_read on orders
  for select using (buyer_id = auth.uid());

drop policy if exists orders_owner_read on orders;
create policy orders_owner_read on orders
  for select using (
    exists (select 1 from venues v where v.id = orders.venue_id and v.owner_id = auth.uid())
  );

drop trigger if exists orders_updated_at on orders;
create trigger orders_updated_at
  before update on orders
  for each row execute function set_updated_at();
