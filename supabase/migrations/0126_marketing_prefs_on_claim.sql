-- 0126_marketing_prefs_on_claim.sql
--
-- Turn the Marketing assistant ON the moment a business ACTIVATES (claims) its listing, so a
-- freshly-claimed venue sees starter offer/post ideas immediately instead of having to find the
-- card, run the wizard, opt in, and switch tabs first.
--
-- Today `venue_marketing_prefs.suggestions_enabled` defaults to false and claiming a venue
-- (request_venue_claim, 0028 / approve_venue_claim, 0007) never touches marketing prefs, so the
-- suggestion engine stays dark until the owner manually opts in. The generator already produces
-- sensible starters from empty prefs (DEFAULT_CAP=20, DEFAULT_TYPES={percent_off,two_for_one} —
-- packages/core/src/suggestions), so the only thing missing is flipping the master switch on.
--
-- APPROACH: a trigger on `venues` that fires when ownership is first conferred (owner_id goes from
-- NULL → not-null — the activation transition, whichever claim path did it) and seeds a prefs row
-- with suggestions ON and the same safe defaults the generator uses. We also stamp `onboarded_at`
-- so the dashboard card opens in its "ON — edit preferences / turn off" summary state (refinement)
-- rather than the first-run "Turn on suggestions" questionnaire, which would be redundant when
-- suggestions are already on. Nothing is ever auto-published — every suggestion stays review-first.
--
-- Forward-only by design: this seeds NEW activations, and does NOT backfill venues claimed before
-- this migration (an owner who deliberately dismissed the wizard keeps their choice; a venue with
-- no prefs row simply hasn't activated under the new rule). `on conflict do nothing` makes it safe
-- against re-claims and any pre-existing row. Idempotent + re-appliable.

create or replace function seed_venue_marketing_prefs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Auto-enable the Marketing assistant with the generator's own defaults. If a prefs row already
  -- exists (re-claim, prior onboarding), leave it untouched — the owner's settings win.
  insert into venue_marketing_prefs
    (venue_id, suggestions_enabled, discount_cap_pct, offer_types, onboarded_at)
  values
    (new.id, true, 20, array['percent_off', 'two_for_one'], now())
  on conflict (venue_id) do nothing;
  return new;
end;
$$;

comment on function seed_venue_marketing_prefs() is
  'Trigger fn: on venue activation (owner_id NULL → set), seed venue_marketing_prefs with the '
  'Marketing assistant ON and the suggestion engine''s default cap/types, so a freshly-claimed '
  'venue gets starter ideas immediately. Never overwrites an existing prefs row.';

drop trigger if exists trg_seed_marketing_prefs_on_claim on venues;
create trigger trg_seed_marketing_prefs_on_claim
  after update of owner_id on venues
  for each row
  when (old.owner_id is null and new.owner_id is not null)
  execute function seed_venue_marketing_prefs();
