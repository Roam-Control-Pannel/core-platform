-- ============================================================================
-- pgTAP regression tests for 0148_fsa_match_dismissals.sql
--
-- The load-bearing properties: the table exists with its venue FK + note bound; client roles can
-- neither READ nor WRITE it (deny-by-omission RLS + the guard tripwire — review state is internal to
-- HQ); the service side can; and a dismissal dies with its venue (cascade).
-- ============================================================================
begin;
select plan(10);

-- ── structural ───────────────────────────────────────────────────────────────
select has_table('public', 'fsa_match_dismissals', 'fsa_match_dismissals exists');
select col_is_pk('public', 'fsa_match_dismissals', 'venue_id', 'venue_id is the primary key (one dismissal per venue)');
select fk_ok('public', 'fsa_match_dismissals', 'venue_id', 'public', 'venues', 'id', 'venue_id → venues(id)');
select has_trigger('public', 'fsa_match_dismissals', 'fsa_match_dismissals_guard', 'client-role guard trigger is installed');

-- ── fixtures (as the test/owner role) ─────────────────────────────────────────
insert into venues (id, name, geo, status, owner_id, categories) values
  ('00000000-0000-0000-0000-00000000e8a1', 'Dismissed Cafe',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6000), 4326), 'unclaimed', null, array['cafe']),
  ('00000000-0000-0000-0000-00000000e8a2', 'Cascade Cafe',
   ST_SetSRID(ST_MakePoint(-5.9310, 54.6010), 4326), 'unclaimed', null, array['cafe']);

-- Service side can write (this session is the owner role; service_role bypasses RLS the same way).
insert into fsa_match_dismissals (venue_id, note) values
  ('00000000-0000-0000-0000-00000000e8a1', 'FSA has no record'),
  ('00000000-0000-0000-0000-00000000e8a2', 'closed');
select is((select count(*) from fsa_match_dismissals)::int, 2, 'service side can insert dismissals');

-- ── note bound ────────────────────────────────────────────────────────────────
select throws_ok(
  $$ update fsa_match_dismissals set note = repeat('x', 201) where venue_id = '00000000-0000-0000-0000-00000000e8a1' $$,
  '23514', null,
  'note is bounded to 200 characters');

-- ── client roles: no read, no write ──────────────────────────────────────────
create temp table _fd (k text primary key, v boolean);
do $$
declare
  anon_rows int := -1;
  anon_write_blocked boolean := false;
  auth_write_blocked boolean := false;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_rows from fsa_match_dismissals;
  begin
    insert into fsa_match_dismissals (venue_id) values ('00000000-0000-0000-0000-00000000e8a1');
  exception when others then anon_write_blocked := true; end;

  -- A DELETE under deny-by-omission RLS does not raise: it silently matches zero rows (so the guard
  -- trigger never fires either). The proof of denial is that the row SURVIVES the attempt.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e8ff","role":"authenticated"}', true);
  begin
    delete from fsa_match_dismissals where venue_id = '00000000-0000-0000-0000-00000000e8a1';
  exception when others then null; end;

  perform set_config('role', 'postgres', true);
  select exists (select 1 from fsa_match_dismissals where venue_id = '00000000-0000-0000-0000-00000000e8a1')
    into auth_write_blocked;
  insert into _fd values
    ('anon_no_read', anon_rows = 0),
    ('anon_no_write', anon_write_blocked),
    ('auth_no_delete', auth_write_blocked);
end $$;
select ok((select v from _fd where k = 'anon_no_read'),   'anon sees no dismissal rows (deny-by-omission select)');
select ok((select v from _fd where k = 'anon_no_write'),  'anon cannot insert a dismissal (RLS raises)');
select ok((select v from _fd where k = 'auth_no_delete'), 'authenticated cannot delete a dismissal (row survives the attempt)');

-- ── cascade ───────────────────────────────────────────────────────────────────
delete from venues where id = '00000000-0000-0000-0000-00000000e8a2';
select is((select count(*) from fsa_match_dismissals where venue_id = '00000000-0000-0000-0000-00000000e8a2')::int,
  0, 'a dismissal is removed with its venue (on delete cascade)');

select * from finish();
rollback;
