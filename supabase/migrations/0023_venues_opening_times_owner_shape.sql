-- ============================================================================
-- Roam — 0023_venues_opening_times_owner_shape.sql
-- Harden the `opening_times` jsonb contract for Slice 8 (Owner Editable Hours).
--
-- WHY a CHECK and not an ALTER COLUMN / new column: the `opening_times` COLUMN already
-- exists (0001), is jsonb, is nullable. Slice 8 introduces a SECOND, additive shape for
-- the same column — owner-authored structured hours — alongside the legacy Places shape.
-- This migration adds no columns; it states the ONE invariant the application layer
-- cannot enforce against a direct or service-role write, exactly the spirit of 0022.
--
-- THE TWO SHAPES this column now carries:
--   Legacy (Places, unchanged since 0018):
--       { "weekdayDescriptions": string[], "source": "google_places" }
--   Structured (owner, new in Slice 8):
--       { "weekdayDescriptions": string[],   -- DERIVED, keeps the existing reader working
--         "periods": [ { "day": 0..6, "closed": bool, "intervals": [...] }, ... ],
--         "timezone": "Europe/London",
--         "source": "owner" }
--
-- THE INVARIANT (and ONLY the invariant) enforced here:
--   If `periods` is present, then:
--     (a) `periods` is a jsonb array, AND
--     (b) `source` = 'owner'.
--   Structured hours can ONLY ever carry owner provenance. Places never writes `periods`
--   (its pure mapper emits only weekdayDescriptions+source), so this can never reject a
--   Places row; it bites only a malformed/forged structured write.
--
-- WHAT IS DELIBERATELY *NOT* IN SQL (single-source-of-truth, per the priority law):
--   The fine structure of periods — HH:MM format, open<close, no-overlap, day-index range,
--   interval caps — lives in ONE place: the pure validator packages/api/src/venue-hours.ts
--   (buildOwnerOpeningTimes), proven by 26 unit tests. Re-encoding those rules in a
--   Postgres check would duplicate logic (brittle jsonb time parsing) and split the
--   contract across two sources. The DB guards the coarse provenance invariant the app
--   can't; the validator guards the fine shape. Two layers, each doing what it's good at —
--   the same split Slice 7 used (RLS = row gate, mutation = column gate).
--
-- PERMISSIVE BY CONSTRUCTION — passes every existing row:
--   - NULL opening_times                      -> pass (no periods key)
--   - legacy Places { weekdayDescriptions, source: google_places } -> pass (no periods key)
--   - owner structured with source=owner       -> pass
--   - owner structured with wrong/absent source -> REJECT (the bite)
--   - periods present but not an array          -> REJECT (the bite)
--
-- Idempotent: drop-if-exists then add, so it re-applies cleanly on a fresh reset.
-- ============================================================================

alter table venues
  drop constraint if exists venues_opening_times_owner_shape;

alter table venues
  add constraint venues_opening_times_owner_shape
  check (
    -- The constraint engages ONLY when a `periods` key is present. Everything else
    -- (NULL, legacy Places shape) trivially satisfies it.
    opening_times is null
    or not (opening_times ? 'periods')
    or (
      jsonb_typeof(opening_times -> 'periods') = 'array'
      and (opening_times ->> 'source') = 'owner'
    )
  );

comment on constraint venues_opening_times_owner_shape on venues is
  'Slice 8 owner-hours invariant: if opening_times carries a `periods` array it MUST be a '
  'jsonb array AND source MUST be ''owner''. Permissive of NULL and the legacy Places '
  'shape (which has no periods key). Fine per-interval validation lives in the pure '
  'validator (packages/api/src/venue-hours.ts), not here — single source of truth.';
