-- ============================================================================
-- pgTAP regression tests for 0137_external_refs.sql
--
-- Proves the match ledger's shape, its PUBLIC READ + NO client write posture (the guard tripwire),
-- the one-match-per-(entity,dataset) uniqueness, and the score bounds. Client-role writes run inside
-- a DO block under SET ROLE; outcomes are stashed and asserted as the owner role afterwards.
-- ============================================================================
begin;
select plan(10);

-- ── structural ───────────────────────────────────────────────────────────────
select has_table('public', 'external_refs', 'external_refs table exists');
select has_column('public', 'external_refs', 'method', 'external_refs has a method column');
select has_column('public', 'external_refs', 'score', 'external_refs has a score column');
select ok(
  (select indisunique from pg_index where indexrelid = 'public.external_refs_entity_dataset_uq'::regclass),
  '(entity_type, entity_id, dataset) index is unique — one match per entity per dataset'
);
select has_trigger('public', 'external_refs', 'external_refs_guard',
  'external_refs has the client-role write guard');

-- ── fixtures (as owner role: bypasses the guard) ──────────────────────────────
insert into external_refs (entity_type, entity_id, dataset, external_id, method, score)
  values ('channel_member', '00000000-0000-0000-0000-0000000ce001', 'roam_venue',
          '00000000-0000-0000-0000-0000000ce0a1', 'auto', 0.912);

create temp table _er (k text primary key, v boolean);

-- Value/uniqueness integrity + public read (as owner, then client roles).
do $$
declare dup boolean := false; bad_score boolean := false;
begin
  begin  -- same (entity_type, entity_id, dataset) → unique violation
    insert into external_refs (entity_type, entity_id, dataset, external_id)
      values ('channel_member', '00000000-0000-0000-0000-0000000ce001', 'roam_venue', 'other');
  exception when others then dup := true; end;

  begin  -- score outside [0,1] → check violation
    insert into external_refs (entity_type, entity_id, dataset, external_id, score)
      values ('venue', '00000000-0000-0000-0000-0000000ce002', 'fsa', 'FHRS123', 1.5);
  exception when others then bad_score := true; end;

  insert into _er values ('dup', dup), ('bad_score', bad_score);
end $$;

select ok((select v from _er where k = 'dup'),       'duplicate (entity, dataset) match is rejected');
select ok((select v from _er where k = 'bad_score'), 'score outside [0,1] is rejected');

-- ── public read + no client write ─────────────────────────────────────────────
do $$
declare
  anon_sees int := -1; auth_insert_blocked boolean := false; auth_update_blocked boolean := false;
begin
  -- anon can READ the ledger (public, no PII).
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_sees from external_refs
    where entity_id = '00000000-0000-0000-0000-0000000ce001';

  -- authenticated cannot forge or edit a match.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000ce0ff","role":"authenticated"}', true);
  begin
    insert into external_refs (entity_type, entity_id, dataset, external_id)
      values ('channel_member', '00000000-0000-0000-0000-0000000ce003', 'roam_venue', 'forged');
  exception when others then auth_insert_blocked := true; end;
  begin
    update external_refs set external_id = 'tampered'
      where entity_id = '00000000-0000-0000-0000-0000000ce001';
    if not found then auth_update_blocked := true; end if;
  exception when others then auth_update_blocked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _er values
    ('anon_reads',          anon_sees = 1),
    ('auth_insert_blocked', auth_insert_blocked),
    ('auth_update_blocked', auth_update_blocked);
end $$;

select ok((select v from _er where k = 'anon_reads'),          'anon CAN read the match ledger (public, no PII)');
select ok((select v from _er where k = 'auth_insert_blocked'), 'authenticated cannot forge a match row');
select ok((select v from _er where k = 'auth_update_blocked'), 'authenticated cannot tamper with a match row');

select * from finish();
rollback;
