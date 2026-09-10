-- ============================================================================
-- pgTAP tests for 0134_channel_config.sql
--
-- Asserts the three config columns exist with the right types/defaults, the surface CHECK holds,
-- and — crucially — that the seed is BEHAVIOUR-NEUTRAL: roam and f2g (seeded in 0116) carry exactly
-- the config that encodes today's behaviour. If a future edit drifts the seed, this fails.
-- ============================================================================
begin;
select plan(11);

-- ── columns exist with expected types + defaults ─────────────────────────────
select has_column('public', 'channels', 'nav', 'channels.nav exists');
select has_column('public', 'channels', 'sections', 'channels.sections exists');
select has_column('public', 'channels', 'surface', 'channels.surface exists');
select col_type_is('public', 'channels', 'nav', 'jsonb', 'nav is jsonb');
select col_type_is('public', 'channels', 'sections', 'jsonb', 'sections is jsonb');
select col_default_is('public', 'channels', 'surface', 'roam', 'surface defaults to roam');

-- ── surface CHECK constraint rejects anything but roam/storefront ─────────────
select throws_ok(
  $$ update channels set surface = 'bogus' where key = 'roam' $$,
  '23514',
  null,
  'surface CHECK rejects an unknown shell'
);

-- ── seed is behaviour-neutral ────────────────────────────────────────────────
select is(
  (select surface from channels where key = 'roam'), 'roam',
  'roam renders the standard chrome'
);
select is(
  (select surface from channels where key = 'f2g'), 'storefront',
  'f2g renders the storefront chrome (today''s isF2G chrome)'
);
select is(
  (select sections->>'storefront' from channels where key = 'f2g'), 'true',
  'f2g exposes the storefront surface'
);
select is(
  (select sections->>'explore' from channels where key = 'f2g'), 'false',
  'f2g does not expose /explore (today''s isRoamOnlyPath redirect)'
);

select * from finish();
rollback;
