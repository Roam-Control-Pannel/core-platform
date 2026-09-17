-- ============================================================================
-- 0152 — The `venue-media` storage bucket and its owner-write policies, captured from the live
--        project (holistic plan Phase 1.6; security backlog A6/C3).
--
-- WHY. Migration 0021 is missing from the repo (the sequence jumps 0020 → 0022). The venue-media
-- bucket and the policies that let a venue owner upload under their venue's folder existed ONLY in
-- the live project: every rebuild from migrations (the CI `db` gate, a disaster-recovery restore, a
-- second environment) produced a database with no bucket and no upload policy, and no test could
-- ever cover the path VenueShopManager / OwnerMediaManager depend on.
--
-- WHAT. The three write policies below are the live definitions, read from pg_policies on
-- 2026-09-17 and reproduced verbatim (same names, same roles, same USING / WITH CHECK): an
-- authenticated caller may insert / update / delete an object in `venue-media` only when the first
-- path segment is the id of a venue they own (venues.owner_id = auth.uid()). Path convention:
-- `{venue_id}/…` — VenueShopManager.tsx and OwnerMediaManager.tsx both build paths this way.
--
-- The live project ALSO still carries `venue_media_read_public` (SELECT, to public). Migration 0076
-- dropped it on purpose: objects in a PUBLIC bucket are served via /storage/v1/object/public/…,
-- which never consults storage.objects RLS, so that policy only ever enabled LISTING the bucket —
-- and nothing in the app lists it (uploads + getPublicUrl only). Its presence live means 0076's
-- drop never reached the project; this migration re-asserts the drop so the repo's decision wins.
--
-- THE ONE DELIBERATE DEVIATION FROM VERBATIM: an owner-scoped SELECT policy is ADDED. Postgres applies
-- SELECT policies to the rows an UPDATE or DELETE must read through its WHERE clause, so with the
-- public read policy gone the live owner update/delete policies silently match nothing (the pgTAP
-- test for this migration proved it: "owner can delete their own object" failed with only the three
-- write policies). Live works today only because 0076 never landed there. `venue_media_owner_select`
-- lets an owner see (list, update, delete) objects under THEIR venues only; the public still cannot
-- enumerate the bucket. Least authority that keeps the write policies meaningful.
--
-- The bucket row is created only if absent (`on conflict do nothing`): the live row's
-- file_size_limit / allowed_mime_types were not part of the captured read, and this migration must
-- not overwrite settings it has not seen. A follow-up records them once read (docs/db-release-runbook.md).
--
-- Idempotent (drop-first policies, guarded bucket insert). Forward-only.
-- ============================================================================

-- 1. The bucket (public read via the CDN object URL). Created only when missing.
insert into storage.buckets (id, name, public)
values ('venue-media', 'venue-media', true)
on conflict (id) do nothing;

-- 2. Owner-write policies on storage.objects, scoped to this bucket — verbatim from live.
drop policy if exists venue_media_owner_insert on storage.objects;
create policy venue_media_owner_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'venue-media'
    and exists (
      select 1 from venues v
      where v.id = ((storage.foldername(objects.name))[1])::uuid
        and v.owner_id = auth.uid()
    )
  );

drop policy if exists venue_media_owner_update on storage.objects;
create policy venue_media_owner_update
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'venue-media'
    and exists (
      select 1 from venues v
      where v.id = ((storage.foldername(objects.name))[1])::uuid
        and v.owner_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'venue-media'
    and exists (
      select 1 from venues v
      where v.id = ((storage.foldername(objects.name))[1])::uuid
        and v.owner_id = auth.uid()
    )
  );

drop policy if exists venue_media_owner_delete on storage.objects;
create policy venue_media_owner_delete
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'venue-media'
    and exists (
      select 1 from venues v
      where v.id = ((storage.foldername(objects.name))[1])::uuid
        and v.owner_id = auth.uid()
    )
  );

-- 3. Owner-scoped read (the deviation above): needed for the owner's own update/delete to see their
--    rows, and lets an owner list their own venue's folder. Same predicate as the write policies.
drop policy if exists venue_media_owner_select on storage.objects;
create policy venue_media_owner_select
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'venue-media'
    and exists (
      select 1 from venues v
      where v.id = ((storage.foldername(objects.name))[1])::uuid
        and v.owner_id = auth.uid()
    )
  );

-- 4. No PUBLIC listing policy (0076 §6): public-bucket object reads bypass RLS; a public SELECT policy
--    only enables enumerating the bucket, which nothing needs and which exposes every owner's paths.
drop policy if exists venue_media_read_public on storage.objects;
