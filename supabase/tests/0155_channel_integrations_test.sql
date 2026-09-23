-- ============================================================================
-- pgTAP regression tests for 0155_channel_integrations.sql
--
-- Load-bearing properties: a partner's OAuth credential is unreachable by client roles (RLS with NO
-- policy, plus the tripwire trigger), one connection per (channel, provider) so re-connecting
-- REPLACES rather than accumulating orphaned grants, and the constraints hold.
-- ============================================================================
begin;
select plan(13);

select has_table('public', 'channel_integrations', 'channel_integrations exists');
select has_column('public', 'channel_integrations', 'refresh_token_encrypted', 'the credential column exists');
select has_column('public', 'channel_integrations', 'external_account_id', 'the connected portal id is recorded');
select has_column('public', 'channel_integrations', 'scopes', 'the granted scopes are recorded');

-- ── the credential is not reachable from a client role ───────────────────────
select ok(
  (select relrowsecurity from pg_class where oid = 'public.channel_integrations'::regclass),
  'RLS is enabled');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'channel_integrations'),
  0,
  'NO policy exists — with RLS on, every client read AND write is denied by omission');

select has_trigger('public', 'channel_integrations', 'channel_integrations_guard',
  'the defence-in-depth tripwire trigger is attached');

-- Belt and braces: even as a client role with the trigger as the only barrier, a write is refused.
insert into channels (key, name, is_default) values ('test-partner-0155', 'Test Partner', false);

set local role authenticated;
select throws_ok(
  $$insert into channel_integrations (channel_id, provider, refresh_token_encrypted)
    select id, 'hubspot', 'v1.x.y.z' from channels where key = 'test-partner-0155'$$,
  '42501',
  null,
  'a client role can never write a partner credential, even if a policy is added by mistake');
reset role;

-- ── constraints ──────────────────────────────────────────────────────────────
insert into channel_integrations (channel_id, provider, refresh_token_encrypted, external_account_id, scopes)
  select id, 'hubspot', 'v1.aa.bb.cc', '12345678', array['crm.objects.companies.read']
  from channels where key = 'test-partner-0155';

select is(
  (select external_account_id from channel_integrations ci
     join channels c on c.id = ci.channel_id where c.key = 'test-partner-0155'),
  '12345678',
  'the connected portal id round-trips');

select throws_ok(
  $$insert into channel_integrations (channel_id, provider, refresh_token_encrypted)
    select id, 'hubspot', 'v1.dd.ee.ff' from channels where key = 'test-partner-0155'$$,
  '23505',
  null,
  'one connection per (channel, provider) — a second grant cannot be left orphaned');

select throws_ok(
  $$insert into channel_integrations (channel_id, provider, refresh_token_encrypted)
    select id, 'salesforce', 'v1.gg.hh.ii' from channels where key = 'test-partner-0155'$$,
  '23514',
  null,
  'an unknown provider is refused until it is deliberately added');

select throws_ok(
  $$update channel_integrations set status = 'probably-fine'
     where channel_id = (select id from channels where key = 'test-partner-0155')$$,
  '23514',
  null,
  'status is constrained to connected|revoked|error');

-- Deleting the channel takes its credential with it, so an offboarded partner leaves none behind.
delete from channels where key = 'test-partner-0155';
select is(
  (select count(*)::int from channel_integrations ci
     left join channels c on c.id = ci.channel_id where c.id is null),
  0,
  'removing a channel cascades its integration away — no orphaned credential survives');

select * from finish();
rollback;
