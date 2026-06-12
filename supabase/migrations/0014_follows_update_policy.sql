-- 0014_follows_update_policy.sql
-- follows had SELECT (follows_read), INSERT (follows_write), and DELETE (follows_delete)
-- policies but no UPDATE, so RLS silently denied every push-preference change:
-- social.setVenuePushEnabled's .update({ push_enabled }) matched zero rows and reported
-- success (ok:true), leaving the mute toggle non-functional — the user mutes a venue, the UI
-- flips optimistically, but the row never changes and pushes keep arriving. Same class of bug
-- as 0012_meetups_update_policy. The push_enabled column landed in 0013 without the policy
-- needed to mutate it. Scope UPDATE to the owner, mirroring follows_write/delete's
-- (follower_id = auth.uid()) predicate; with check blocks reassigning a row to another user.
create policy follows_update on follows
  for update
  using (follower_id = auth.uid())
  with check (follower_id = auth.uid());
