-- ============================================================================
-- pgTAP regression tests for 0152_venue_media_storage.sql
--
-- Load-bearing property: a venue owner can write (and see) objects under THEIR venue's folder in
-- venue-media and nobody else can — not a stranger, not anon, not the owner under a venue they don't
-- own. The public cannot list the bucket (no public SELECT policy, per 0076), and the owner-scoped
-- SELECT is what keeps the owner's own update/delete alive (without it those matched nothing).
-- ============================================================================
begin;
select plan(16);

-- ── structural ───────────────────────────────────────────────────────────────
select is((select public from storage.buckets where id = 'venue-media'), true,
  'the venue-media bucket exists and is public');
select ok(exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'venue_media_owner_insert' and cmd = 'INSERT' and roles = '{authenticated}'),
  'venue_media_owner_insert: INSERT, authenticated');
select ok(exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'venue_media_owner_update' and cmd = 'UPDATE' and roles = '{authenticated}'),
  'venue_media_owner_update: UPDATE, authenticated');
select ok(exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'venue_media_owner_delete' and cmd = 'DELETE' and roles = '{authenticated}'),
  'venue_media_owner_delete: DELETE, authenticated');
select ok(exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'venue_media_owner_select' and cmd = 'SELECT' and roles = '{authenticated}'),
  'venue_media_owner_select: SELECT, authenticated (owner-scoped, not public)');
select ok(not exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'venue_media_read_public'),
  'no PUBLIC listing policy on venue-media (0076 §6 re-asserted)');

-- ── fixtures (owner role) ────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e5201', 'owner-a@venue.example'),
  ('00000000-0000-0000-0000-0000000e5202', 'stranger-b@rival.example');

insert into venues (id, name, geo, status, owner_id) values
  ('00000000-0000-0000-0000-0000000e52c1', 'Owned By A',
   ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'claimed', '00000000-0000-0000-0000-0000000e5201'),
  ('00000000-0000-0000-0000-0000000e52c2', 'Owned By B',
   ST_SetSRID(ST_MakePoint(-5.9302, 54.5974), 4326), 'claimed', '00000000-0000-0000-0000-0000000e5202');

create temp table _sm (k text primary key, v boolean);
do $$
declare
  a_own boolean := false; b_steal boolean := false; a_other boolean := false; anon_ins boolean := false;
  a_upd boolean := false; b_del boolean := false; a_del boolean := false;
  a_sees integer := -1; b_sees integer := -1; anon_sees integer := -1;
begin
  -- Supabase Storage (tenant migration 0055) attaches a STATEMENT-level BEFORE DELETE trigger to
  -- storage.objects that raises unless this setting is 'true' — the Storage API sets it on its own
  -- deletes. It fires even when the statement matches zero rows, so it is set here (transaction-
  -- local) for the whole block; RLS still decides which rows each role's DELETE can reach.
  perform set_config('storage.allow_delete_query', 'true', true);
  -- Owner A uploads under their own venue's folder → allowed.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e5201","role":"authenticated"}', true);
  begin
    insert into storage.objects (bucket_id, name) values ('venue-media', '00000000-0000-0000-0000-0000000e52c1/products/a.webp');
    a_own := true;
  exception when others then a_own := false; end;
  -- Owner A under a venue they do NOT own → denied.
  begin
    insert into storage.objects (bucket_id, name) values ('venue-media', '00000000-0000-0000-0000-0000000e52c2/products/x.webp');
    a_other := true;
  exception when insufficient_privilege then a_other := false; end;

  -- Stranger B writes under A's venue → denied; B deletes A's object → silently 0 rows.
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e5202","role":"authenticated"}', true);
  begin
    insert into storage.objects (bucket_id, name) values ('venue-media', '00000000-0000-0000-0000-0000000e52c1/products/b.webp');
    b_steal := true;
  exception when insufficient_privilege then b_steal := false; end;
  delete from storage.objects where bucket_id = 'venue-media' and name = '00000000-0000-0000-0000-0000000e52c1/products/a.webp';
  b_del := found;
  select count(*) into b_sees from storage.objects where bucket_id = 'venue-media';

  -- Anon → denied, and sees nothing (no public listing).
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    insert into storage.objects (bucket_id, name) values ('venue-media', '00000000-0000-0000-0000-0000000e52c1/products/anon.webp');
    anon_ins := true;
  exception when insufficient_privilege then anon_ins := false; end;
  select count(*) into anon_sees from storage.objects where bucket_id = 'venue-media';

  -- Owner A sees their own object, then updates and deletes it → allowed (it survived B's delete).
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e5201","role":"authenticated"}', true);
  select count(*) into a_sees from storage.objects where bucket_id = 'venue-media';
  update storage.objects set name = '00000000-0000-0000-0000-0000000e52c1/products/a2.webp'
    where bucket_id = 'venue-media' and name = '00000000-0000-0000-0000-0000000e52c1/products/a.webp';
  a_upd := found;
  delete from storage.objects where bucket_id = 'venue-media' and name = '00000000-0000-0000-0000-0000000e52c1/products/a2.webp';
  a_del := found;

  perform set_config('role', 'postgres', true);
  insert into _sm values ('a_own', a_own), ('a_other', a_other), ('b_steal', b_steal), ('b_del', b_del),
                         ('anon_ins', anon_ins), ('a_upd', a_upd), ('a_del', a_del),
                         ('a_sees', a_sees = 1), ('b_sees', b_sees = 0), ('anon_sees', anon_sees = 0);
end $$;

select ok((select v from _sm where k = 'a_own'),        'owner can upload under their own venue folder');
select ok(not (select v from _sm where k = 'a_other'),  'owner cannot upload under a venue they do not own');
select ok(not (select v from _sm where k = 'b_steal'),  'a stranger cannot upload under someone else''s venue');
select ok(not (select v from _sm where k = 'b_del'),    'a stranger''s delete touches nothing');
select ok(not (select v from _sm where k = 'anon_ins'), 'anon cannot upload at all');
select ok((select v from _sm where k = 'a_sees'),       'owner sees exactly their own venue''s object');
select ok((select v from _sm where k = 'b_sees'),       'a stranger sees none of it');
select ok((select v from _sm where k = 'anon_sees'),    'anon sees none of it (no public listing)');
select ok((select v from _sm where k = 'a_upd'),        'owner can update (rename) their own object');
select ok((select v from _sm where k = 'a_del'),        'owner can delete their own object');

select * from finish();
rollback;
