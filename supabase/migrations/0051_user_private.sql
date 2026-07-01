-- 0051_user_private.sql
--
-- Private, owner-only user data — the cornerstone of doing "birthdays for businesses" safely.
--
-- birth_date is PERSONAL DATA and must never be world-readable, so it does NOT live on `profiles`
-- (whose read policy is `using (true)`). It lives here in a table whose ONLY policy is owner-only:
-- a user can read/write their own row and nothing else can read it directly. Businesses never see
-- this table — they get aggregates (age bands with a minimum-count floor) and birthday-offer
-- OUTCOMES via SECURITY DEFINER functions added in later phases, never an individual date.
--
--   birth_date              — the user's date of birth (optional).
--   birthday_offers_enabled — explicit opt-in to receive birthday treats from places they follow.
--
-- Additive + idempotent; safe to run once on the Roam-Core project.

create table if not exists user_private (
  user_id                 uuid primary key references profiles(id) on delete cascade,
  birth_date              date,
  birthday_offers_enabled boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table user_private enable row level security;

-- Owner-only, full stop. No public read (unlike profiles). This is the whole point of the table.
drop policy if exists user_private_owner_all on user_private;
create policy user_private_owner_all on user_private for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop trigger if exists trg_user_private_updated on user_private;
create trigger trg_user_private_updated before update on user_private
  for each row execute function set_updated_at();
