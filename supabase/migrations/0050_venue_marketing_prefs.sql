-- 0050_venue_marketing_prefs.sql
--
-- Business marketing preferences, captured by the claim-time onboarding wizard (and editable later
-- from the dashboard). Drives the suggestion engine (Phase 4): the discount CAP it should never
-- exceed, the offer THEMES the business likes, a free-text note on what they discount, and the
-- master opt-in for automated post/push suggestions.
--
-- One row per venue, owner-only (RLS via the venue's owner_id). onboarded_at marks that the wizard
-- has been completed OR dismissed, so the first-run prompt doesn't nag. Additive + idempotent.

create table if not exists venue_marketing_prefs (
  venue_id            uuid primary key references venues(id) on delete cascade,
  suggestions_enabled boolean not null default false,
  discount_cap_pct    integer check (discount_cap_pct is null or (discount_cap_pct between 0 and 50)),
  offer_types         text[] not null default '{}',
  product_notes       text,
  onboarded_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table venue_marketing_prefs enable row level security;

-- Owner-only read + write (a business manages its own marketing prefs).
drop policy if exists vmp_owner_all on venue_marketing_prefs;
create policy vmp_owner_all on venue_marketing_prefs for all
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()))
  with check (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop trigger if exists trg_vmp_updated on venue_marketing_prefs;
create trigger trg_vmp_updated before update on venue_marketing_prefs
  for each row execute function set_updated_at();
