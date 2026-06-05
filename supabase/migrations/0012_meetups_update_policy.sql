-- 0012_meetups_update_policy.sql
-- meetups had SELECT (meetups_read) + INSERT (meetups_write) policies but no UPDATE,
-- so RLS silently denied every state transition (voting->resolved, ->ended): the
-- orchestrators' .update() matched zero rows and reported success. Scope UPDATE to
-- thread participants, mirroring the read/write policies' in_thread(thread_id) predicate.
create policy meetups_update on meetups
  for update
  using (in_thread(thread_id))
  with check (in_thread(thread_id));
