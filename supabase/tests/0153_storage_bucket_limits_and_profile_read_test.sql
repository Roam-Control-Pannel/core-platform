-- ============================================================================
-- pgTAP regression tests for 0153_storage_bucket_limits_and_profile_read.sql
--
-- Load-bearing properties: the venue-media bucket carries the live limits; profile-media has an
-- owner-scoped read and no public listing, and the owner's own update/delete still reach their rows.
-- ============================================================================
begin;
select plan(12);

-- ── venue-media limits ───────────────────────────────────────────────────────
select is((select file_size_limit from storage.buckets where id = 'venue-media'), 10485760::bigint,
  'venue-media: 10 MB object cap (as live)');
select is((select allowed_mime_types from storage.buckets where id = 'venue-media'),
  array['image/jpeg', 'image/png', 'image/webp'], 'venue-media: jpeg/png/webp only (as live)');

-- ── profile-media policies ───────────────────────────────────────────────────
select ok(exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'profile_media_owner_select' and cmd = 'SELECT' and roles = '{authenticated}'),
  'profile_media_owner_select: SELECT, authenticated (owner-scoped)');
select ok(not exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'profile_media_public_read'),
  'no PUBLIC listing policy on profile-media (0076 §6 re-asserted)');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e5301', 'user-a@profile.example'),
  ('00000000-0000-0000-0000-0000000e5302', 'user-b@profile.example');

create temp table _pm (k text primary key, v boolean);
do $$
declare
  a_own boolean := false; b_steal boolean := false; anon_ins boolean := false;
  a_sees integer := -1; b_sees integer := -1; anon_sees integer := -1;
  b_del boolean := false; a_upd boolean := false; a_del boolean := false;
begin
  -- Supabase Storage's statement-level delete guard (see 0152's test).
  perform set_config('storage.allow_delete_query', 'true', true);

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e5301","role":"authenticated"}', true);
  begin
    insert into storage.objects (bucket_id, name) values ('profile-media', '00000000-0000-0000-0000-0000000e5301/avatar.webp');
    a_own := true;
  exception when others then a_own := false; end;

  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e5302","role":"authenticated"}', true);
  begin
    insert into storage.objects (bucket_id, name) values ('profile-media', '00000000-0000-0000-0000-0000000e5301/evil.webp');
    b_steal := true;
  exception when insufficient_privilege then b_steal := false; end;
  select count(*) into b_sees from storage.objects where bucket_id = 'profile-media';
  delete from storage.objects where bucket_id = 'profile-media' and name = '00000000-0000-0000-0000-0000000e5301/avatar.webp';
  b_del := found;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    insert into storage.objects (bucket_id, name) values ('profile-media', '00000000-0000-0000-0000-0000000e5301/anon.webp');
    anon_ins := true;
  exception when insufficient_privilege then anon_ins := false; end;
  select count(*) into anon_sees from storage.objects where bucket_id = 'profile-media';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e5301","role":"authenticated"}', true);
  select count(*) into a_sees from storage.objects where bucket_id = 'profile-media';
  update storage.objects set name = '00000000-0000-0000-0000-0000000e5301/avatar2.webp'
    where bucket_id = 'profile-media' and name = '00000000-0000-0000-0000-0000000e5301/avatar.webp';
  a_upd := found;
  delete from storage.objects where bucket_id = 'profile-media' and name = '00000000-0000-0000-0000-0000000e5301/avatar2.webp';
  a_del := found;

  perform set_config('role', 'postgres', true);
  insert into _pm values ('a_own', a_own), ('b_steal', b_steal), ('anon_ins', anon_ins),
                         ('a_sees', a_sees = 1), ('b_sees', b_sees = 0), ('anon_sees', anon_sees = 0),
                         ('b_del', b_del), ('a_upd', a_upd), ('a_del', a_del);
end $$;

select ok((select v from _pm where k = 'a_own'),        'a user can upload under their own folder');
select ok(not (select v from _pm where k = 'b_steal'),  'another user cannot upload under that folder');
select ok(not (select v from _pm where k = 'anon_ins'), 'anon cannot upload');
select ok((select v from _pm where k = 'a_sees'),       'a user sees exactly their own object');
select ok((select v from _pm where k = 'b_sees'),       'another user sees none of it');
select ok(not (select v from _pm where k = 'b_del'),    'another user''s delete touches nothing');
select ok((select v from _pm where k = 'a_upd') and (select v from _pm where k = 'a_del'),
  'the owner can still update and delete their own object (needs the owner read)');
select ok((select v from _pm where k = 'anon_sees'),    'anon sees none of it (no public listing)');

select * from finish();
rollback;
