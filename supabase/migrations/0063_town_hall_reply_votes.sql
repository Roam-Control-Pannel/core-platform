-- 0063_town_hall_reply_votes.sql
-- Comment (reply) upvotes for Town Hall — mirrors town_hall_votes (0030) for replies. A
-- denormalised upvote_count on town_hall_replies is kept by a SECURITY DEFINER trigger (the voter
-- is not the reply's author, so the UPDATE must bypass the author-only write RLS on replies).

alter table public.town_hall_replies
  add column if not exists upvote_count integer not null default 0;

create table if not exists public.town_hall_reply_votes (
  reply_id   uuid not null references public.town_hall_replies(id) on delete cascade,
  voter_id   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reply_id, voter_id)
);

create or replace function public.town_hall_bump_reply_upvotes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.town_hall_replies set upvote_count = upvote_count + 1 where id = new.reply_id;
  elsif tg_op = 'DELETE' then
    update public.town_hall_replies set upvote_count = greatest(0, upvote_count - 1) where id = old.reply_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_town_hall_reply_votes_count on public.town_hall_reply_votes;
create trigger trg_town_hall_reply_votes_count
  after insert or delete on public.town_hall_reply_votes
  for each row execute function public.town_hall_bump_reply_upvotes();

alter table public.town_hall_reply_votes enable row level security;

-- A voter manages (and can read) only their OWN vote row — same posture as town_hall_votes.
drop policy if exists town_hall_reply_votes_read on public.town_hall_reply_votes;
create policy town_hall_reply_votes_read on public.town_hall_reply_votes
  for select using (voter_id = auth.uid());
drop policy if exists town_hall_reply_votes_insert on public.town_hall_reply_votes;
create policy town_hall_reply_votes_insert on public.town_hall_reply_votes
  for insert with check (voter_id = auth.uid());
drop policy if exists town_hall_reply_votes_delete on public.town_hall_reply_votes;
create policy town_hall_reply_votes_delete on public.town_hall_reply_votes
  for delete using (voter_id = auth.uid());
