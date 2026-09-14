-- ============================================================================
-- pgTAP regression tests for 0141_fsa_establishments.sql
--
-- Proves the FSA corpus's shape + posture: PUBLIC READ (open data, must render on the venue page) but
-- NO client WRITE — the guard trigger blocks anon/authenticated inserts/updates/deletes, so only the
-- service-role sync can populate it. fhrsid is unique (idempotent re-sync).
-- ============================================================================
begin;
select plan(8);

select has_table('public', 'fsa_establishments', 'fsa_establishments table exists');
select has_column('public', 'fsa_establishments', 'rating_value', 'has the verbatim rating_value column');
select has_column('public', 'fsa_establishments', 'fhrsid', 'has the FHRSID key');
select ok(
  (select indisunique from pg_index where indexrelid = 'public.fsa_establishments_fhrsid_key'::regclass),
  'fhrsid is unique (idempotent re-sync)'
);
select has_trigger('public', 'fsa_establishments', 'fsa_establishments_guard', 'has the client-write guard');

-- Fixture (owner role: bypasses RLS + guard).
insert into fsa_establishments (fhrsid, business_name, postcode, rating_value, rating_key, rating_date)
  values ('123456', 'Verbatim Cafe', 'BT1 1AA', '5', 'fhrs_5_en-gb', '2026-01-15');

create temp table _fsa (k text primary key, v boolean);

do $$
declare anon_sees int := -1; ins_blocked boolean := false; upd_blocked boolean := false;
begin
  -- anon CAN read (public open data).
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_sees from fsa_establishments where fhrsid = '123456';

  -- authenticated CANNOT write.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000cd0ff","role":"authenticated"}', true);
  begin
    insert into fsa_establishments (fhrsid, business_name, rating_value) values ('999', 'Evil', '0');
  exception when others then ins_blocked := true; end;
  begin
    update fsa_establishments set rating_value = '0' where fhrsid = '123456';
    if not found then upd_blocked := true; end if; -- RLS-silent 0-row update counts as blocked
  exception when others then upd_blocked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _fsa values
    ('anon_can_read',  anon_sees = 1),
    ('insert_blocked', ins_blocked),
    ('update_blocked', upd_blocked),
    ('rating_intact',  (select rating_value = '5' from fsa_establishments where fhrsid = '123456'));
end $$;

select ok((select v from _fsa where k = 'anon_can_read'),  'anon CAN read the public FSA corpus');
select ok((select v from _fsa where k = 'insert_blocked'), 'a client role cannot INSERT an FSA row (guard)');
select ok((select v from _fsa where k = 'rating_intact'),  'a client UPDATE never mutated the rating');

select * from finish();
rollback;
