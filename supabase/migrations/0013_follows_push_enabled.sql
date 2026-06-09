-- Per-venue push delivery preference on the follow edge.
-- Follow defaults to push-on; the per-venue toggle flips this without
-- requiring an unfollow. dispatchFollowerPush filters on this column so a
-- muted follow stays a follow but receives no web-push.
alter table follows
  add column push_enabled boolean not null default true;

comment on column follows.push_enabled is
  'When false, follower still follows the venue but is excluded from follower_push fan-out.';
