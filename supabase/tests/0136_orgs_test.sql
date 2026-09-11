-- ============================================================================
-- pgTAP regression tests for 0136_orgs.sql
--
-- Proves the orgs directory's shape, the moderation HARD GATE (only approved+live is public), the
-- 0125 live-or-own read, that B1 opened NO client INSERT path, the column guard, unique slugs, and
-- that the slug definer is revoked from client roles (the existence-oracle lesson). Client-role
-- reads/writes run under SET ROLE in DO blocks; outcomes are stashed and asserted as owner.
-- ============================================================================
begin;
select plan(12);

-- ── structural ───────────────────────────────────────────────────────────────
select has_table('public', 'orgs', 'orgs table exists');
select has_column('public', 'orgs', 'moderation', 'orgs has a moderation column');
select col_type_is('public', 'orgs', 'moderation', 'moderation_status',
  'orgs.moderation reuses the shared moderation_status enum');

-- ── fixtures (as the test/owner role: bypasses RLS + guard) ───────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a001', 'org-owner-a@example.com'),
  ('00000000-0000-0000-0000-00000000b002', 'org-owner-b@example.com');

-- A draft/pending org owned by A (for read-own + guard), and a live/approved org (for public read).
insert into orgs (id, owner_id, name, status, moderation) values
  ('00000000-0000-0000-0000-00000000d001',
   '00000000-0000-0000-0000-00000000a001', 'Draft Supplier', 'draft', 'pending'),
  ('00000000-0000-0000-0000-00000000d002',
   null, 'Live Supplier', 'live', 'approved');

-- Two orgs sharing a name → slugs must diverge.
insert into orgs (id, name, locality) values
  ('00000000-0000-0000-0000-00000000d003', 'Dupe Supplier', 'Belfast'),
  ('00000000-0000-0000-0000-00000000d004', 'Dupe Supplier', 'Belfast');

select isnt(
  (select slug from orgs where id = '00000000-0000-0000-0000-00000000d003'),
  (select slug from orgs where id = '00000000-0000-0000-0000-00000000d004'),
  'two orgs with the same name get distinct slugs'
);

create temp table _o (k text primary key, v boolean);

-- ── read visibility (moderation gate + live-or-own) ───────────────────────────
do $$
declare
  anon_live int := -1; anon_draft int := -1;
  a_sees_own int := -1; b_sees_a int := -1;
begin
  -- anon: sees the live+approved org, never the draft/pending one.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_live  from orgs where id = '00000000-0000-0000-0000-00000000d002';
  select count(*) into anon_draft from orgs where id = '00000000-0000-0000-0000-00000000d001';

  -- owner A: sees their own draft via orgs_read_own.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}', true);
  select count(*) into a_sees_own from orgs where id = '00000000-0000-0000-0000-00000000d001';

  -- owner B: must NOT see A's unapproved draft.
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000b002","role":"authenticated"}', true);
  select count(*) into b_sees_a from orgs where id = '00000000-0000-0000-0000-00000000d001';

  perform set_config('role', 'postgres', true);
  insert into _o values
    ('anon_sees_live',   anon_live = 1),
    ('anon_hides_draft', anon_draft = 0),
    ('a_sees_own_draft', a_sees_own = 1),
    ('b_hidden_from_a',  b_sees_a = 0);
end $$;

select ok((select v from _o where k = 'anon_sees_live'),   'anon sees a live+approved org');
select ok((select v from _o where k = 'anon_hides_draft'), 'moderation gate: anon never sees a draft/pending org');
select ok((select v from _o where k = 'a_sees_own_draft'), 'owner sees their OWN draft (0125 live-or-own read)');
select ok((select v from _o where k = 'b_hidden_from_a'),  'a different user cannot see someone else''s unapproved org');

-- ── no client INSERT (B1), column guard, and the slug-definer revoke ──────────
do $$
declare
  insert_blocked boolean := false; desc_ok boolean := false;
  mod_blocked boolean := false; slug_revoked boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}', true);

  -- B1 exposes no client INSERT: creating an org as a client role must fail (that is C3's path).
  begin
    insert into orgs (owner_id, name) values ('00000000-0000-0000-0000-00000000a001', 'Sneaky Org');
    if not found then insert_blocked := true; end if;
  exception when others then insert_blocked := true; end;

  -- Owner CAN edit a presentational field.
  update orgs set description = 'we supply bakeries' where id = '00000000-0000-0000-0000-00000000d001';
  desc_ok := found;

  -- Owner CANNOT self-approve (moderation is server/definer-managed) → guard raises.
  begin
    update orgs set moderation = 'approved' where id = '00000000-0000-0000-0000-00000000d001';
  exception when others then mod_blocked := true; end;

  -- The slug definer is an existence oracle → revoked from client roles.
  begin
    perform gen_unique_org_slug('probe', 'belfast');
  exception when others then slug_revoked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _o values
    ('insert_blocked', insert_blocked),
    ('desc_ok',        desc_ok),
    ('mod_blocked',    mod_blocked),
    ('slug_revoked',   slug_revoked);
end $$;

select ok((select v from _o where k = 'insert_blocked'), 'B1 opens no client INSERT on orgs (self-serve is C3)');
select ok((select v from _o where k = 'desc_ok'),        'owner CAN edit a presentational field (description)');
select ok((select v from _o where k = 'mod_blocked'),    'owner CANNOT self-approve — moderation is guard-protected');
select ok((select v from _o where k = 'slug_revoked'),   'gen_unique_org_slug EXECUTE is revoked from client roles');

select * from finish();
rollback;
