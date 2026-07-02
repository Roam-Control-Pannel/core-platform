-- 0056_birthday_delivery_fix_ambiguity.sql
--
-- Bugfix for 0055. deliver_birthday_offers() RETURNS TABLE(user_id, venue_id, code, ...) — those
-- OUT-parameter names collide with the same-named columns referenced bare inside the body (the
-- ins CTE's RETURNING list, and `select distinct venue_id, venue_name, title from capped`). plpgsql
-- flagged those as "column reference ... is ambiguous" at RUNTIME, so the function raised and the
-- delivery job got a 500. The fix is the standard directive for a set-returning function whose OUT
-- columns share names with table columns: `#variable_conflict use_column` resolves every ambiguous
-- bare reference to the COLUMN (never the OUT param). The table-qualified references in the final
-- SELECT are unaffected, and `per_user_cap` (a declared var with no same-named column) still binds
-- to the variable. Body is otherwise identical to 0055. Signature unchanged → create or replace.

create or replace function deliver_birthday_offers()
returns table (
  user_id uuid,
  venue_id uuid,
  venue_name text,
  title text,
  code text,
  push_ok boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  per_user_cap int := 5;
begin
  return query
  with eligible as (
    select
      bo.venue_id, v.name as venue_name, bo.title, f.follower_id as user_id,
      coalesce(f.push_enabled, false) as push_ok,
      row_number() over (
        partition by f.follower_id
        order by
          (select count(*) from offer_saves s join offers o on o.id = s.offer_id
             where o.venue_id = bo.venue_id and s.profile_id = f.follower_id) desc,
          f.created_at desc
      ) as rnk
    from venue_birthday_offer bo
    join venues v on v.id = bo.venue_id
    join follows f on f.venue_id = bo.venue_id
    join user_private up on up.user_id = f.follower_id
    where bo.enabled = true
      and up.birthday_offers_enabled = true and up.birth_date is not null
      and extract(month from up.birth_date) = extract(month from now())
      and extract(day from up.birth_date) = extract(day from now())
  ),
  capped as (
    select * from eligible where rnk <= per_user_cap
  ),
  ins as (
    insert into birthday_deliveries (venue_id, user_id, delivered_on, code, expires_at, title)
    select c.venue_id, c.user_id, current_date, upper(substr(md5(random()::text), 1, 6)), current_date + 7, c.title
    from capped c
    on conflict (venue_id, user_id, delivered_on) do nothing
    returning venue_id, user_id, code, expires_at
  ),
  notified as (
    insert into notifications (recipient_id, type, payload)
    select i.user_id, 'birthday_offer',
      jsonb_build_object(
        'text', '🎂 Happy birthday! ' || coalesce(e.title, 'A birthday treat') || ' from ' || e.venue_name,
        'href', '/venue/' || i.venue_id,
        'venueId', i.venue_id, 'venueName', e.venue_name,
        'code', i.code, 'expiresAt', i.expires_at
      )
    from ins i
    join (select distinct venue_id, venue_name, title from capped) e on e.venue_id = i.venue_id
    returning 1
  )
  select i.user_id, i.venue_id, c.venue_name, c.title, i.code, c.push_ok
  from ins i
  join capped c on c.venue_id = i.venue_id and c.user_id = i.user_id;
end;
$$;

revoke all on function deliver_birthday_offers() from public;
grant execute on function deliver_birthday_offers() to service_role;
