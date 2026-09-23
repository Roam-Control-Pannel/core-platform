-- ============================================================================
-- 0154 — Member IDENTITY (where a roster row's stable name comes from) and ONE canonical
--        definition of what it means to be a member of a channel.
--
-- WHY NOW. The F2G Association's real roster arrived on 2026-09-23: `Name | Postcode | Address |
-- Town/City`, and their CEO confirmed **no membership numbers until 2027**. The plan had made the
-- membership number both the KEY and the CREDENTIAL (holistic plan §3.2 rev 2); it can be neither.
--
--   * As a KEY: with no number, membership_ref falls back to a key DERIVED from name+postcode
--     (@roam/core/membership/import.ts derivedRef). Those are fields the Association edits. Correct
--     a typo in their spreadsheet and the derived key changes, so the next import INSERTS A DUPLICATE
--     MEMBER instead of updating one. The unique index in 0135 is only as stable as the key fed to
--     it, and this key is not stable. Identity therefore has to come from the system of record: the
--     Association keeps its membership in HubSpot, whose object ids are immutable.
--   * As a CREDENTIAL: covered by Phase 2.4, not here.
--
-- WHAT THIS MIGRATION DOES.
--   1. channel_members gains source_system / source_system_id (the CRM's own identity), member_no
--      (reserved for 2027, an ATTRIBUTE and never the key), and last_seen_import_id.
--   2. venue_channels gains `role` (member | listed) — the table has been key-only since 0116, so a
--      venue an owner self-tagged and a venue on the Association's roster were indistinguishable.
--   3. channels gains contact_email / org_name (the recon's "no Association identity").
--   4. ONE canonical membership predicate, applied everywhere it was said differently:
--
--        MEMBERSHIP (counted, listed, ranked):  status = 'live' AND venue_id IS NOT NULL
--        ENTITLEMENT (may post as a member):    membership AND claimed_by = auth.uid()
--
--      These are deliberately two predicates, not one. 0150 shipped an HQ "mark live" action whose
--      own doc says a staff-marked member "still needs to claim/activate to post — but they ARE
--      counted, listed and ranked as a member from this moment". Collapsing the two (as the plan's
--      wording "live AND claimed_by set AND a venue" would) would silently un-rank every member HQ
--      has marked live. The plan text is corrected in rev 3 to match what shipped.
--
--      Before this migration the predicate was said three different ways: the ranking helper counted
--      `claimed|live` and every venue_channels tag; the directory counted `live` only; the two
--      entitlement functions counted `live` + claimed_by but not a bound venue.
--   5. Consequently the claim definer (0139) now writes 'live' rather than 'claimed'. 0150 backfilled
--      exactly these rows (claimed + claimant + bound venue) to 'live' because they had "already
--      proven themselves"; a NEW claim through the same definer proves the same thing, so leaving it
--      at 'claimed' meant every future claimant landed OUTSIDE the live-only predicate and needed a
--      manual HQ step to be ranked. That was an oversight in 1.2, not a design. `claimed` becomes a
--      legacy status: still valid, still in the state machine, but nothing writes it any more.
--   6. Council is DERIVED from the matched venue's FSA establishment rather than trusted from the
--      roster. The real sample's Town/City column disagrees with its own postcodes (a BT23 6FR row
--      labelled "Belfast"; Carryduff labelled "Belfast"), and it is a town, not a council area.
--
-- Additive and idempotent. No data is destroyed; every new column is nullable or defaulted to
-- today's behaviour. After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

-- ── 1. channel_members: identity that survives the Association editing their own data ────────────
alter table channel_members
  add column if not exists source_system       text,
  add column if not exists source_system_id    text,
  add column if not exists member_no           text,
  add column if not exists last_seen_import_id uuid references channel_import_runs(id) on delete set null;

do $$
begin
  -- Known systems of record. 'csv' is a hand-uploaded export (no stable id); 'hubspot' is the
  -- Association's CRM. Extending this list is a one-line migration, which is the point of naming it.
  if not exists (select 1 from pg_constraint where conname = 'channel_members_source_system_check') then
    alter table channel_members add constraint channel_members_source_system_check
      check (source_system is null or source_system in ('csv', 'hubspot'));
  end if;

  -- A system without an id in it cannot identify anything, and an id with no system is ambiguous.
  if not exists (select 1 from pg_constraint where conname = 'channel_members_source_system_pair_check') then
    alter table channel_members add constraint channel_members_source_system_pair_check
      check ((source_system is null) = (source_system_id is null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'channel_members_member_no_check') then
    alter table channel_members add constraint channel_members_member_no_check
      check (member_no is null or char_length(member_no) between 1 and 64);
  end if;
end $$;

-- The real idempotency key once a system of record is attached: one member per (channel, system, id).
-- Partial, so rows imported from a bare CSV (no stable id) are unaffected.
create unique index if not exists channel_members_source_system_uq
  on channel_members (channel_id, source_system, source_system_id)
  where source_system is not null;

-- A membership number, when they exist from 2027, is unique within a channel — but it is an
-- ATTRIBUTE. The key stays (channel, source_system, source_system_id): re-keying a live roster later
-- is a migration nobody should have to run, and a second whitelabel may never issue numbers at all.
create unique index if not exists channel_members_member_no_uq
  on channel_members (channel_id, member_no)
  where member_no is not null;

comment on column channel_members.source_system is
  'System of record this row came from: ''hubspot'' (the Association''s CRM) or ''csv'' (a hand-uploaded export). Null for rows imported before 0154.';
comment on column channel_members.source_system_id is
  'That system''s own immutable id for the member (e.g. a HubSpot company id). This is the stable identity the Association''s membership numbers were meant to provide and will not until 2027: unlike membership_ref''s derived fallback, it does not change when a name or postcode is corrected.';
comment on column channel_members.member_no is
  'The Association''s membership number, from 2027. An ATTRIBUTE, never the idempotency key — see the unique indexes above and holistic plan §3.2.';
comment on column channel_members.last_seen_import_id is
  'The most recent import run that still contained this member. The roster-lifecycle rule (lapse after a grace period when a member stops appearing) reads this — and is deliberately NOT enabled until identity comes from source_system_id, because lapsing on a key derived from an editable name would retire members over a corrected typo.';

-- ── 2. venue_channels.role — a roster member vs a venue that merely listed itself ────────────────
-- Default 'member' is chosen so EXISTING rows keep behaving exactly as they do today: before this
-- migration every tag counted towards the member tier, so defaulting to 'member' is a no-op for live
-- ranking. Phase 2.4's non-member path is what starts writing 'listed'.
alter table venue_channels
  add column if not exists role text not null default 'member';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'venue_channels_role_check') then
    alter table venue_channels add constraint venue_channels_role_check
      check (role in ('member', 'listed'));
  end if;
end $$;

create index if not exists venue_channels_role_idx on venue_channels (channel_id, role);

comment on column venue_channels.role is
  '''member'' — on the channel''s roster (ranked and badged as a member). ''listed'' — a non-member that opted its venue into the storefront: it is listed, but it is never ranked or badged as a member. Existing rows default to ''member'', which preserves pre-0154 ranking exactly.';

-- ── 3. channels: who the partner actually is ─────────────────────────────────────────────────────
alter table channels
  add column if not exists contact_email text,
  add column if not exists org_name      text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'channels_contact_email_check') then
    alter table channels add constraint channels_contact_email_check
      check (contact_email is null or (char_length(contact_email) between 3 and 320 and position('@' in contact_email) > 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'channels_org_name_check') then
    alter table channels add constraint channels_org_name_check
      check (org_name is null or char_length(org_name) between 1 and 200);
  end if;
end $$;

comment on column channels.contact_email is 'The partner organisation''s own contact address (not a Roam address).';
comment on column channels.org_name is 'The partner''s legal/trading organisation name, where it differs from the channel''s display name.';

update channels
   set org_name = coalesce(org_name, 'NI Food to Go Association')
 where key = 'f2g';

-- ── 4a. the canonical membership predicate, in the ranking helper ────────────────────────────────
-- Was: status in ('claimed','live') UNION every venue_channels tag. Now: live + bound venue, UNION
-- only tags whose role is 'member'. Signature and return type are unchanged, so every caller and the
-- schema-drift guard's probe are unaffected.
create or replace function public.f2g_member_venue_ids(p_channel_id uuid)
returns table (venue_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.venue_id
    from channel_members m
   where m.channel_id = p_channel_id
     and m.venue_id is not null
     and m.status = 'live'
  union
  select vc.venue_id
    from venue_channels vc
   where vc.channel_id = p_channel_id
     and vc.role = 'member';
$$;

comment on function public.f2g_member_venue_ids(uuid) is
  'THE canonical member-venue set for a channel: roster members that are live AND matched to a venue, UNION venues tagged into the channel with role=''member''. SECURITY DEFINER so it can read the service-managed roster, but projects ONLY venue_id (no PII). Null channel → no rows. Membership here does NOT require claimed_by — a member HQ marked live is counted, listed and ranked; posting as a member additionally requires claimed_by (see f2g_can_post_as_member).';

revoke all on function public.f2g_member_venue_ids(uuid) from public, anon, authenticated;
grant execute on function public.f2g_member_venue_ids(uuid) to anon, authenticated;

-- ── 4b. members-mode listing: show listed non-members, but never RANK them as members ────────────
-- A non-member that opted in is a legitimate storefront listing (holistic plan §3.2, the non-member
-- activation path) — it simply gets no member priority and no badge. So the function keeps returning
-- both roles and gains the same trailing `is_member` column venues_food_to_go_near got in 0145,
-- making the two discovery RPCs genuinely the same shape (which the API's shared row mapper,
-- venues.ts toStorefrontCard, already assumed).
drop function if exists venues_in_channel_near(uuid, double precision, double precision, integer, integer);

create function venues_in_channel_near(filter_channel_id uuid, origin_lat double precision, origin_lng double precision,
  page_size integer default 20, page_offset integer default 0)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid,
  prep_time_mins integer, is_member boolean)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id,
    vcs.prep_time_mins,
    (fm.venue_id is not null) as is_member
  from venues v
  left join venue_collection_settings vcs on vcs.venue_id = v.id
  -- The canonical member set, read once through the PII-free definer helper.
  left join (select venue_id from f2g_member_venue_ids(filter_channel_id)) fm on fm.venue_id = v.id
  where exists (select 1 from venue_channels vc where vc.venue_id = v.id and vc.channel_id = filter_channel_id)
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  -- Members first, then claimed, then the rest — nearest-first within each tier, matching
  -- venues_food_to_go_near so the storefront ranks identically in either membership mode.
  order by (fm.venue_id is not null) desc,
    (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 20), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

revoke all on function venues_in_channel_near(uuid, double precision, double precision, integer, integer) from public;
grant execute on function venues_in_channel_near(uuid, double precision, double precision, integer, integer)
  to anon, authenticated;

comment on function venues_in_channel_near(uuid, double precision, double precision, integer, integer) is
  'Members-mode storefront discovery: a channel''s tagged venues near a point, member-first then claimed then nearest, with prep_time_mins and is_member. A role=''listed'' non-member is listed but never ranked or badged as a member (0154).';

-- ── 4c. the public directory: live AND matched, with the council derived from the FSA register ───
drop function if exists channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer);

create function channel_members_search(
  p_channel_key text,
  p_query       text default null,
  p_council     text default null,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_radius_m    double precision default null,   -- NULL = nationwide (no distance fence)
  p_limit       integer default 25,
  p_offset      integer default 0
)
returns table (
  member_id      uuid,
  name           text,               -- source_name (the public business name; SAFE)
  council        text,               -- derived: roster value, else the matched venue's FSA authority
  status         text,
  venue_id       uuid,
  venue_slug     text,
  venue_name     text,
  venue_locality text,
  venue_rating   numeric,
  distance_m     double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with origin as (
    select case
      when p_lat is not null and p_lng is not null
      then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
    end as g
  )
  select
    m.id, m.source_name,
    coalesce(m.source_council, fe.local_authority) as council,
    m.status,
    v.id, v.slug, v.name, v.locality, v.rating,
    case when o.g is not null and v.geo is not null then st_distance(v.geo, o.g) end
  from channel_members m
  join channels c on c.id = m.channel_id and c.key = p_channel_key
  -- Inner join: the canonical predicate requires a matched venue, and a directory entry with no
  -- venue has nothing to show anyway.
  join venues v on v.id = m.venue_id
  -- Council of record: the FSA register's local_authority for this venue, via the match the nightly
  -- FSA sync wrote. The roster's own council/town column is not trustworthy (see the header).
  left join external_refs fer
    on fer.entity_type = 'venue' and fer.entity_id = v.id and fer.dataset = 'fsa'
  left join fsa_establishments fe on fe.fhrsid = fer.external_id
  cross join origin o
  where m.status = 'live'                                             -- only live members are public
    and (p_query   is null or m.source_name ilike '%' || replace(replace(p_query, '\', '\\'), '%', '\%') || '%')
    and (p_council is null or coalesce(m.source_council, fe.local_authority) = p_council)
    and (
      o.g is null or p_radius_m is null                              -- nationwide when no origin/radius
      or (v.geo is not null and st_dwithin(v.geo, o.g, p_radius_m))
    )
  order by
    case when o.g is not null and v.geo is not null then st_distance(v.geo, o.g) end asc nulls last,
    m.source_name asc
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

comment on function channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer) is
  'Public members-directory search (C2). SECURITY DEFINER over the service-managed roster, projecting ONLY safe columns (name/council/status + the matched venue''s public basics) — never source_email/source_phone. Applies the canonical membership predicate (live AND matched to a venue) and derives the council from the matched venue''s FSA establishment, falling back to the roster''s own value. Radius is a parameter (NULL = nationwide).';

revoke all on function channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer) from public;
grant execute on function channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer) to anon, authenticated;

-- ── 4d. entitlements: membership + the caller's own claim ────────────────────────────────────────
-- Unchanged in spirit; the bound-venue half of the canonical predicate is now explicit rather than
-- implied by the paths that happen to set 'live'.
create or replace function public.f2g_can_post_as_member(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from channel_members m
    where m.channel_id = p_channel_id
      and m.claimed_by = auth.uid()
      and m.status = 'live'
      and m.venue_id is not null
  );
$$;

comment on function public.f2g_can_post_as_member(uuid) is
  'Entitlement seam (decisions #9): true iff auth.uid() is a member of p_channel_id under the canonical predicate (live + matched to a venue) AND has claimed it. SECURITY DEFINER (reads the service-managed roster) but scoped to the caller''s own membership. Used by the job_posts insert policy (C4) and reused by the orgs self-serve insert policy (C3). A future paywall replaces this body.';

create or replace function public.f2g_can_post_supplier()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from channel_members m
    join channels c on c.id = m.channel_id
    where c.key = 'f2g'
      and m.claimed_by = auth.uid()
      and m.status = 'live'
      and m.venue_id is not null
  );
$$;

comment on function public.f2g_can_post_supplier() is
  'Entitlement (decision #9) for self-serve supplier creation: true iff auth.uid() is a claimed, live, venue-matched member of the f2g channel. The f2g-scoped sibling of f2g_can_post_as_member (0142); gates the orgs self-insert policy.';

revoke all on function public.f2g_can_post_as_member(uuid) from public, anon;
grant execute on function public.f2g_can_post_as_member(uuid) to authenticated;
revoke all on function public.f2g_can_post_supplier() from public, anon;
grant execute on function public.f2g_can_post_supplier() to authenticated;

-- ── 5. the claim definer lands on 'live', and tags the venue as a member ─────────────────────────
-- Identical to 0139 except for three lines, each marked below. Reproduced in full because a
-- SECURITY DEFINER that confers venue ownership should be readable in one piece, not assembled from
-- a diff against an older migration.
create or replace function claim_channel_member_venue(
  p_member_id   uuid,
  p_venue_id    uuid,
  p_claimant_id uuid
)
returns channel_member_claim_result
language plpgsql
security definer
set search_path = public
as $$
declare
  m         channel_members;
  v_status  venue_status;
  v_owner   uuid;
  result    channel_member_claim_result;
begin
  if p_claimant_id is null then
    raise exception 'CLAIMANT_REQUIRED' using errcode = 'P0001';
  end if;

  -- Lock the member row first (same lock order everywhere: member then venue).
  select * into m from channel_members where id = p_member_id for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The token binds a specific (member, venue) pair. Refuse if the member is not matched to exactly
  -- that venue — this is what stops a captured token being re-pointed at a different venue.
  if m.venue_id is null or m.venue_id <> p_venue_id then
    raise exception 'VENUE_MISMATCH' using errcode = 'P0001';
  end if;

  -- Lock the venue row too.
  select status, owner_id into v_status, v_owner from venues where id = p_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Single-use via STATE. Only an imported/invited member is claimable.
  if m.status not in ('imported', 'invited') then
    -- CHANGED (0154): a successful claim now lands on 'live', so the idempotent re-click branch must
    -- recognise 'live' as well as the legacy 'claimed' — otherwise re-clicking a link that worked
    -- would raise NOT_CLAIMABLE instead of returning the same no-op success.
    if m.status in ('claimed', 'live') and m.claimed_by is not distinct from p_claimant_id then
      result := (m.id, p_venue_id, false, v_status, 'already_claimed');
      return result;
    end if;
    -- Anything else (claimed by someone else, lapsed, removed) is not claimable via this link.
    raise exception 'NOT_CLAIMABLE' using errcode = 'P0001';
  end if;

  -- Never steal an existing claim: if the venue is already owned by a DIFFERENT user, refuse. (An
  -- unclaimed venue has owner_id NULL; a re-run where owner is already the claimant falls through.)
  if v_owner is not null and v_owner <> p_claimant_id then
    raise exception 'CLAIMED_BY_OTHER' using errcode = 'P0001';
  end if;

  -- ── Confer ownership — the dangerous write, done here and ONLY here. ────────────────────────────
  update venues
    set status = 'claimed', owner_id = p_claimant_id
    where id = p_venue_id;

  -- CHANGED (0154): 'live', not 'claimed'. This claimant has done exactly what 0150's backfill
  -- treated as proof of membership (a verified invite, a bound venue, a signed-in claimant), so
  -- leaving them at 'claimed' would place them outside the canonical live-only predicate and require
  -- a manual HQ step to be ranked or listed.
  update channel_members
    set status = 'live', claimed_by = p_claimant_id, claimed_at = now()
    where id = m.id;

  -- Accept side-effect: tag the venue into its channel. CHANGED (0154): the tag now carries
  -- role='member', and an existing 'listed' tag is UPGRADED — someone who self-listed and then
  -- claimed through an Association invite is a member, not a listing.
  insert into venue_channels (channel_id, venue_id, added_by, role)
    values (m.channel_id, p_venue_id, p_claimant_id, 'member')
    on conflict (channel_id, venue_id) do update set role = 'member';

  -- The outcome string stays 'claimed': it is the API's success token (packages/api/src/f2g/invite.ts
  -- ClaimOutcome), not a description of the member's status.
  result := (m.id, p_venue_id, true, 'claimed'::venue_status, 'claimed');
  return result;
end;
$$;

comment on function claim_channel_member_venue(uuid, uuid, uuid) is
  'Service-role invite→claim conferral for a channel_members roster member. Confers ownership of the matched venue (venues -> claimed, owner_id=claimant; member -> LIVE + claimed_by/at) and tags venue_channels with role=''member'', ONLY when the member is matched to p_venue_id, is imported/invited, and the venue is not owned by another user. Idempotent no-op on a same-claimant re-click. NOT granted to anon/authenticated — the API calls it with the service client after verifying the invite token and the signed-in claimant. 0154 moved the landing status from ''claimed'' to ''live'' so a claimant is immediately a member under the canonical predicate.';

revoke all on function claim_channel_member_venue(uuid, uuid, uuid) from public, anon, authenticated;
