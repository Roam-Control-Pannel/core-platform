-- ============================================================================
-- pgTAP regression tests for 0142_job_posts.sql
--
-- Proves the employability board's gate: only a LIVE channel member may post (the entitlement seam),
-- the moderation read gate, author-owned writes, and the expiry sweep. The insert/update attempts run
-- under SET ROLE authenticated (auth.uid() resolved from the jwt sub); outcomes are stashed and
-- asserted as the owner role afterwards.
-- ============================================================================
begin;
select plan(11);

-- ── structural ───────────────────────────────────────────────────────────────
select has_table('public', 'job_posts', 'job_posts table exists');
select has_function('public', 'f2g_can_post_as_member', array['uuid'], 'the entitlement seam exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.f2g_can_post_as_member(uuid)'::regprocedure),
  true, 'f2g_can_post_as_member is SECURITY DEFINER');
select has_function('public', 'close_expired_job_posts', 'the expiry sweep exists');
select ok(
  not has_function_privilege('authenticated', 'public.close_expired_job_posts()', 'execute'),
  'authenticated CANNOT run the expiry sweep (service_role only)');

-- ── fixtures (owner role: bypasses RLS + the roster guard) ────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000cd0a1', 'live-member@f2g.example'),   -- A: a LIVE member
  ('00000000-0000-0000-0000-0000000cd0a2', 'not-a-member@rando.example'); -- B: not a member

-- A is a live member of f2g; B is not on the roster at all.
insert into channel_members (id, channel_id, source_name, membership_ref, status, claimed_by)
select '00000000-0000-0000-0000-0000000cd0b1', c.id, 'Member A Cafe', 'ASSOC-C4A', 'live',
       '00000000-0000-0000-0000-0000000cd0a1'
from channels c where c.key = 'f2g';

-- An already-expired published post (owner-inserted) for the sweep test.
insert into job_posts (id, author_id, channel_id, title, locality, locality_label, apply_url, status, expires_at)
select '00000000-0000-0000-0000-0000000cd0f1', '00000000-0000-0000-0000-0000000cd0a1', c.id,
       'Expired Barista', 'belfast', 'Belfast', 'https://apply.example/1', 'published', now() - interval '1 day'
from channels c where c.key = 'f2g';

create temp table _jp (k text primary key, v boolean);

do $$
declare a_ok boolean := false; a_closed_blocked boolean := false; b_blocked boolean := false; b_upd_blocked boolean := false;
begin
  -- As live member A.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000cd0a1","role":"authenticated"}', true);
  begin
    insert into job_posts (author_id, channel_id, title, locality, locality_label, apply_url)
    select '00000000-0000-0000-0000-0000000cd0a1', id, 'Barista wanted', 'belfast', 'Belfast', 'https://apply.example/2'
    from channels where key = 'f2g';
    a_ok := true;
  exception when others then a_ok := false; end;

  -- A cannot insert a row that starts 'closed' (with-check requires published).
  begin
    insert into job_posts (author_id, channel_id, title, locality, locality_label, apply_url, status)
    select '00000000-0000-0000-0000-0000000cd0a1', id, 'Sneaky closed', 'belfast', 'Belfast', 'https://apply.example/3', 'closed'
    from channels where key = 'f2g';
  exception when others then a_closed_blocked := true; end;

  -- As non-member B: the entitlement gate rejects the insert.
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000cd0a2","role":"authenticated"}', true);
  begin
    insert into job_posts (author_id, channel_id, title, locality, locality_label, apply_url)
    select '00000000-0000-0000-0000-0000000cd0a2', id, 'Not allowed', 'belfast', 'Belfast', 'https://apply.example/4'
    from channels where key = 'f2g';
  exception when others then b_blocked := true; end;

  -- B cannot edit A's post (author-owned update → 0 rows).
  update job_posts set title = 'hijacked' where id = '00000000-0000-0000-0000-0000000cd0f1';
  if not found then b_upd_blocked := true; end if;

  perform set_config('role', 'postgres', true);
  insert into _jp values
    ('a_ok', a_ok), ('a_closed_blocked', a_closed_blocked),
    ('b_blocked', b_blocked), ('b_upd_blocked', b_upd_blocked);
end $$;

select ok((select v from _jp where k = 'a_ok'),             'a LIVE member can post a job');
select ok((select v from _jp where k = 'b_blocked'),        'a non-member cannot post (entitlement gate)');
select ok((select v from _jp where k = 'a_closed_blocked'), 'a post cannot start closed (with-check requires published)');
select ok((select v from _jp where k = 'b_upd_blocked'),    'a non-author cannot edit a post');

-- anon can read an approved post.
do $$
declare anon_sees int := -1;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_sees from job_posts where id = '00000000-0000-0000-0000-0000000cd0f1';
  perform set_config('role', 'postgres', true);
  insert into _jp values ('anon_reads', anon_sees = 1);
end $$;
select ok((select v from _jp where k = 'anon_reads'), 'anon can read an approved post');

-- the sweep closes the expired post.
select is(public.close_expired_job_posts() >= 1, true, 'the sweep closes at least the expired post');
select is(
  (select status from job_posts where id = '00000000-0000-0000-0000-0000000cd0f1'),
  'closed', 'the expired post is now closed');

select * from finish();
rollback;
