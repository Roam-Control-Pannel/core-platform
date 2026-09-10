-- ============================================================================
-- 0134_channel_config.sql
--
-- Turns channel dispatch from a hardcoded boolean into configuration (review debt D3, F2G plan A2).
-- Today `isF2G` is branched in ~32 sites across 9 web files and `channelKeyForHost()` hardcodes the
-- f2g key; adding the Association's four new sections behind that pattern means editing every branch,
-- and the next whitelabel partner is a code change rather than a config row. This migration adds the
-- three config columns those branches will read instead:
--
--   nav      — the channel's own header navigation, an ordered array of { key, href, labelKey }.
--              Empty [] means "use the surface's default chrome nav" (roam's TopBar).
--   sections — an explicit ALLOW-MAP of the top-level surfaces this channel exposes:
--              { "<sectionKey>": true }. A section absent or false is NOT exposed. Keys today:
--              storefront, suppliers, jobs, explore, townHall, market, deals, events. Explicit (not
--              default-on) so a brand-new channel exposes nothing until configured — a safe default.
--   surface  — which shell chrome to render: 'roam' (TopBar + SideNav rail) or 'storefront' (the
--              branded header, no rail). Replaces the isF2G chrome branches with one switch.
--
-- BEHAVIOUR-NEUTRAL BY CONSTRUCTION: this slice only adds the columns and seeds roam + f2g to encode
-- exactly today's behaviour. Nothing reads nav/sections/surface yet — the web consumers migrate off
-- isF2G in a following slice, and route-level gating (which is a deliberate behaviour change, not a
-- neutral swap) lands with the Association's sections, reviewed on its own. Shipping the config first,
-- unconsumed, is what makes that later swap safe and reviewable.
--
-- Idempotent. Forward-only. Documented in `comment on column` as 0116 documents `theme`.
-- ============================================================================

alter table channels
  add column if not exists nav      jsonb not null default '[]'::jsonb,
  add column if not exists sections jsonb not null default '{}'::jsonb,
  add column if not exists surface  text  not null default 'roam';

-- Guard `surface` to the two shells we render. Added separately so a re-run doesn't error on an
-- already-present constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'channels_surface_check'
  ) then
    alter table channels
      add constraint channels_surface_check check (surface in ('roam', 'storefront'));
  end if;
end $$;

comment on column channels.nav is
  'The channel''s own header nav: ordered jsonb array of { key: text, href: text, labelKey: text }. '
  '[] = use the surface''s default chrome nav (roam''s TopBar). Parsed by @roam/core/channels.parseChannelNav.';
comment on column channels.sections is
  'Explicit ALLOW-MAP of the top-level surfaces this channel exposes: { "<sectionKey>": true }. '
  'A key absent or false is NOT exposed (no default-on). Keys: storefront, suppliers, jobs, explore, '
  'townHall, market, deals, events. Parsed by @roam/core/channels.parseChannelSections / isSectionEnabled.';
comment on column channels.surface is
  'Which shell chrome to render: ''roam'' (TopBar + SideNav rail) or ''storefront'' (branded header, '
  'no rail). Replaces the isF2G chrome branches.';

-- ── Seed roam (the default, everything-included Roam experience) ──────────────────────────────
-- surface 'roam' (standard chrome); its real top-level surfaces on; no channel nav (uses TopBar).
update channels
   set surface  = 'roam',
       nav      = '[]'::jsonb,
       sections = '{"explore":true,"townHall":true,"market":true,"deals":true,"events":true}'::jsonb
 where key = 'roam';

-- ── Seed f2g (the NI Food to Go storefront) to EXACTLY today's behaviour ──────────────────────
-- surface 'storefront' (the branded navy header, no rail — today's isF2G chrome); the storefront is
-- its only exposed surface and /explore is not (today's isRoamOnlyPath redirect); nav = the four
-- items StorefrontHeader renders today (Near me · Categories · Order again · For members).
update channels
   set surface  = 'storefront',
       sections = '{"storefront":true,"explore":false}'::jsonb,
       nav      = '[
         {"key":"nearMe","href":"/","labelKey":"nav_nearMe"},
         {"key":"categories","href":"/#categories","labelKey":"nav_categories"},
         {"key":"orderAgain","href":"/orders","labelKey":"nav_orderAgain"},
         {"key":"forMembers","href":"/business","labelKey":"nav_forMembers"}
       ]'::jsonb
 where key = 'f2g';
