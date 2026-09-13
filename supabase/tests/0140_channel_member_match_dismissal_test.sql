-- ============================================================================
-- pgTAP regression tests for 0140_channel_member_match_dismissal.sql
--
-- Proves the B4b dismissal columns exist and that they inherit channel_members' service-managed
-- posture: the guard trigger still blocks a client-role write to the new marker, so only
-- service_role / SECURITY DEFINER (the audited admin action) can dismiss a member.
-- ============================================================================
begin;
select plan(4);

select has_column('public', 'channel_members', 'match_dismissed_at', 'has the match_dismissed_at marker');
select has_column('public', 'channel_members', 'match_dismissed_by', 'has the match_dismissed_by attribution');
select ok(
  (select indexrelid is not null from pg_index where indexrelid = 'public.channel_members_review_idx'::regclass),
  'the partial review-queue index exists'
);

-- Fixture (owner role: bypasses RLS + guard).
insert into channel_members (id, channel_id, source_name, membership_ref, status)
select '00000000-0000-0000-0000-0000000cd0b1', c.id, 'Dismiss Test', 'ASSOC-B4B1', 'imported'
from channels c where c.key = 'f2g';

create temp table _md (k text primary key, v boolean);

do $$
declare client_blocked boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000cd0ff","role":"authenticated"}', true);
  begin
    update channel_members set match_dismissed_at = now()
      where membership_ref = 'ASSOC-B4B1';
    if not found then client_blocked := true; end if; -- RLS-silent 0 rows also counts as blocked
  exception when others then client_blocked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _md values ('client_blocked', client_blocked);
end $$;

select ok((select v from _md where k = 'client_blocked'),
  'a client role cannot set match_dismissed_at (service-managed guard still holds)');

select * from finish();
rollback;
