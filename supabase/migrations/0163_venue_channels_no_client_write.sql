-- ============================================================================
-- 0163 — the contract half: `venue_channels` loses its last client write (F2G plan 2.4).
--
-- WHY THIS IS A SEPARATE MIGRATION. It was originally inside 0161, and that was a sequencing error
-- worth recording rather than quietly fixing.
--
-- The release runbook's rule is SCHEMA LEADS CODE: apply the migration, then deploy. That is right
-- for an ADDITIVE change — the app must not read a column that is not there yet. It is exactly
-- backwards for a DESTRUCTIVE one: dropping something the RUNNING code still depends on breaks it
-- until the deploy lands. A removal needs CODE FIRST, THEN SCHEMA.
--
-- 0161 did both at once, so neither rule could be honoured, and it deadlocked for real: the
-- schema-drift guard went red as soon as 0161 merged (its new tables were not applied yet), the
-- deploy host gates on the check suite and therefore would not ship the code that stops needing this
-- policy, and the policy could not be dropped until that code shipped. Splitting it is the fix, and
-- expand/contract is the pattern the next migration with a removal in it should follow.
--
-- ORDER, THEREFORE. 0161 + 0162 applied → drift guard green → the app deploys → THEN this. Applying
-- 0163 before `channels.tagVenue` routes through `tag_venue_listing` will break self-serve listing
-- for exactly as long as it takes the deploy to land.
--
-- WHAT IT CLOSES. 0160 narrowed `venue_channels_owner_write` to `role = 'listed'` as an emergency
-- fix while a live privilege escalation was open. That stopped an owner declaring their own venue a
-- MEMBER, but it still let a signed-in owner write the table directly through PostgREST, into ANY
-- channel — bypassing the Northern-Ireland fence, which exists only in the tRPC router
-- (`f2g.isVenueInFoodToGoRegion`) and cannot be expressed in a row policy.
--
-- With the policy gone, `venue_channels` has NO client-writable path at all. 'listed' comes from
-- `tag_venue_listing`, 'member' from an audited HQ action or `activate_channel_member_venue` — all
-- three SECURITY DEFINER, all three revoked from every client role (0161).
--
-- After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

drop policy if exists venue_channels_owner_write on venue_channels;

-- SELECT stays world-readable via `venue_channels_read` (0116); this only ever governed writes.

comment on column venue_channels.role is
  '''member'' — ranked and badged as a channel member. ''listed'' — a non-member that opted its venue '
  'into the storefront: listed, never ranked or badged. NO DEFAULT, deliberately (0160). There is NO '
  'client-writable path to this table at all since 0163 dropped venue_channels_owner_write: '
  '''listed'' comes from tag_venue_listing, ''member'' from an audited HQ action or '
  'activate_channel_member_venue, and all three are service-role only.';
