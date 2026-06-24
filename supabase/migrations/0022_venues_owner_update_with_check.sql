-- ============================================================================
-- 0022_venues_owner_update_with_check.sql  (Slice 7 — Owner Editable Details)
-- ============================================================================
-- Hardens the existing owner-UPDATE RLS on `venues`. As created in 0004:
--
--     create policy venues_owner_update on venues for update
--       using (owner_id = auth.uid() and status = 'claimed');
--
-- ...this has a `using` clause (which existing rows the caller may target) but NO
-- explicit `with check` (what the row may look like AFTER the update). Postgres then
-- reuses the `using` expression as the check — which happens to be safe today, but only
-- IMPLICITLY. Slice 6's lesson was precisely that RLS behaviour you reasoned about but
-- did not make explicit and execute is a latent trap. So we state the post-image
-- constraint outright: after an owner update the row MUST still be owned by the caller
-- and still claimed. An owner therefore cannot, in the same statement, reassign
-- owner_id to someone else or move status out of 'claimed' — the write is rejected.
--
-- This does NOT add column-scoping: RLS gates rows + post-image, not which columns an
-- UPDATE touches. Column-scope (owners may write ONLY description + links, never rating,
-- category, geo, place_id, …) is enforced one layer up, in the updateVenueDetails tRPC
-- mutation, which builds its patch object from a validated input containing only those
-- two fields. RLS = row gate; procedure shape = column gate. Two layers, each doing the
-- job it is good at — the same split Slice 6 used for storage bytes vs. metadata rows.
--
-- Idempotent: `alter policy` updates the live policy in place (no drop/recreate window).
-- ============================================================================

alter policy venues_owner_update on venues
  using (owner_id = auth.uid() and status = 'claimed')
  with check (owner_id = auth.uid() and status = 'claimed');

comment on policy venues_owner_update on venues is
  'Owner may UPDATE only their own claimed venue, and the post-update row must remain '
  'owned by the caller and claimed (explicit with check, 0022). Column-scope (description '
  '+ links only) is enforced in the updateVenueDetails tRPC mutation, not here.';
