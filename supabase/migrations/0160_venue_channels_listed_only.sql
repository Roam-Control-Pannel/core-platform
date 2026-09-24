-- ============================================================================
-- 0160 — a venue owner may LIST their venue, never declare it a member (F2G plan 2.4).
--
-- THE DEFECT THIS CLOSES. 0154 added `venue_channels.role` with `default 'member'` and made
-- `f2g_member_venue_ids` union `venue_channels where role = 'member'`. The default was deliberate —
-- it preserved pre-0154 ranking for rows that already existed. What was missed is that the
-- SELF-SERVE tagging path (channels.tagVenue → tagVenueIntoChannel) inserts without a role, so from
-- 0154 onward an owner listing their own venue on the storefront silently became a MEMBER: member
-- priority in ranking (0145), the member badge, and a row in the members directory — with no
-- Association roster involvement at all.
--
-- Worse, `venue_channels_owner_write` (0116) constrains only WHICH venue may be written, never which
-- role, so a signed-in owner could also set `role = 'member'` explicitly through PostgREST and
-- self-declare membership of any channel.
--
-- Two changes, both narrow:
--   1. The owner-write policy now permits `role = 'listed'` ONLY. Membership becomes unreachable
--      from a client credential; the only paths to `role = 'member'` are the audited HQ action
--      (adminActions.setVenueChannel) and SECURITY DEFINER activation, both service-side.
--   2. `venue_channels.role` no longer defaults. A write must say what it means. The default is what
--      turned an omission in application code into a privilege grant, and removing it means the same
--      omission now fails loudly instead.
--
-- NOT REMEDIATED HERE. Existing rows cannot be sorted by origin: `venue_channels` has `added_by` but
-- pre-0154 rows predate any role distinction, and a row added by HQ is indistinguishable from one a
-- venue self-tagged. Rewriting them blind would demote legitimate members the Association placed.
-- The review query is in the runbook; the decision is the Association's, not this migration's.
--
-- After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

-- ── 1. the owner may list, not join ─────────────────────────────────────────────────────────────
drop policy if exists venue_channels_owner_write on venue_channels;

-- SELECT stays world-readable via venue_channels_read (0116); this governs writes only.
create policy venue_channels_owner_write on venue_channels
  for all
  using (
    exists (
      select 1 from venues v
      where v.id = venue_channels.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  )
  with check (
    exists (
      select 1 from venues v
      where v.id = venue_channels.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
    -- The whole point of this migration. A client-credential write may only ever say 'listed'.
    and role = 'listed'
  );

-- ── 2. no default: a write must state its meaning ───────────────────────────────────────────────
-- Existing rows keep whatever they hold; this changes only what a future insert that omits the
-- column does — which is now to fail the not-null constraint rather than to grant membership.
alter table venue_channels alter column role drop default;

comment on column venue_channels.role is
  '''member'' — ranked and badged as a channel member. ''listed'' — a non-member that opted its venue '
  'into the storefront: listed, never ranked or badged. NO DEFAULT, deliberately: an insert that '
  'omits it fails rather than silently conferring membership (the 0154 defect 0160 closes). A client '
  'credential may only write ''listed'' — ''member'' is reachable only from an audited HQ action or a '
  'SECURITY DEFINER activation.';
