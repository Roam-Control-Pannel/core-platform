-- Migration 0040 — trigram indexes for user search.
--
-- profiles.search runs case-insensitive substring matches on display_name + handle
-- (find people Instagram/LinkedIn-style). A plain b-tree can't accelerate `ilike '%q%'`,
-- so we add pg_trgm GIN indexes — the standard Postgres pattern for substring search.
--
-- Search works WITHOUT these (sequential scan); they keep it fast as the user base grows.
-- Idempotent: extension + indexes are create-if-not-exists.

create extension if not exists pg_trgm;

create index if not exists idx_profiles_display_name_trgm
  on public.profiles using gin (display_name gin_trgm_ops);

create index if not exists idx_profiles_handle_trgm
  on public.profiles using gin (handle gin_trgm_ops);
