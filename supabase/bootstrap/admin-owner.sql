-- Run after the founder has created their Supabase Auth account.
-- This is intentionally separate from migrations because auth.users may be empty
-- when a database is first built.
do $$
declare
  founder_id uuid;
begin
  select id into founder_id
  from auth.users
  where lower(email) = 'andrew@roam-everywhere.com';

  if founder_id is null then
    raise exception 'Founder auth user andrew@roam-everywhere.com does not exist';
  end if;

  insert into public.admin_users (id, role, note)
  values (founder_id, 'owner', 'Founder — granted by supabase/bootstrap/admin-owner.sql')
  on conflict (id) do update
  set role = excluded.role,
      note = coalesce(public.admin_users.note, excluded.note);
end
$$;
