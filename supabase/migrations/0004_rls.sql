-- ============================================================================
-- Roam — 0004_rls.sql
-- Row-Level Security as code. This is a HARD GATE: Roam is on the open internet
-- and in app stores. RLS is the data model's immune system, not app-layer hope.
--
-- Convention: enable RLS on every table, then grant exactly what each actor needs.
-- Service-role (Edge Functions / server-to-server, validated by x-internal-call)
-- bypasses RLS by design and is the only path for privileged writes.
-- ============================================================================

-- Helper: current authenticated profile id.
create or replace function current_profile() returns uuid
language sql stable as $$ select auth.uid() $$;

-- Helper: are two profiles friends (accepted, either direction)?
create or replace function are_friends(a uuid, b uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from friendships f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b)
        or (f.requester_id = b and f.addressee_id = a))
  );
$$;

-- Helper: is the current user a participant in a chat thread?
create or replace function in_thread(t uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from chat_participants cp
    where cp.thread_id = t and cp.profile_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- feature_flags: world-readable (clients need to know what's on), writable
-- only by service role.
-- ---------------------------------------------------------------------------
alter table feature_flags enable row level security;
create policy ff_read on feature_flags for select using (true);

-- ---------------------------------------------------------------------------
-- profiles: world-readable (public discovery), self-writable.
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
create policy profiles_read on profiles for select using (true);
create policy profiles_insert on profiles for insert with check (id = auth.uid());
create policy profiles_update on profiles for update using (id = auth.uid());
create policy profiles_delete on profiles for delete using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- venues: world-readable (unclaimed venues are the global default and must be
-- browsable by anyone, signed in or not). Writable by owner once claimed.
-- Claiming (status transition) goes through service role to enforce verification.
-- ---------------------------------------------------------------------------
alter table venues enable row level security;
create policy venues_read on venues for select using (true);
create policy venues_owner_update on venues for update
  using (owner_id = auth.uid() and status = 'claimed');

-- ---------------------------------------------------------------------------
-- follows: world-readable counts; a user manages only their own follows.
-- ---------------------------------------------------------------------------
alter table follows enable row level security;
create policy follows_read on follows for select using (true);
create policy follows_write on follows for insert with check (follower_id = auth.uid());
create policy follows_delete on follows for delete using (follower_id = auth.uid());

-- ---------------------------------------------------------------------------
-- friendships: visible to the two parties; managed by them.
-- ---------------------------------------------------------------------------
alter table friendships enable row level security;
create policy friendships_read on friendships for select
  using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy friendships_insert on friendships for insert
  with check (requester_id = auth.uid());
create policy friendships_update on friendships for update
  using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy friendships_delete on friendships for delete
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- ---------------------------------------------------------------------------
-- plans + membership: visible to members; owner manages.
-- ---------------------------------------------------------------------------
alter table plans enable row level security;
create policy plans_read on plans for select
  using (owner_id = auth.uid()
    or exists (select 1 from plan_members m where m.plan_id = id and m.profile_id = auth.uid()));
create policy plans_insert on plans for insert with check (owner_id = auth.uid());
create policy plans_update on plans for update using (owner_id = auth.uid());
create policy plans_delete on plans for delete using (owner_id = auth.uid());

alter table plan_members enable row level security;
create policy plan_members_read on plan_members for select
  using (profile_id = auth.uid()
    or exists (select 1 from plans p where p.id = plan_id and p.owner_id = auth.uid()));
create policy plan_members_write on plan_members for insert
  with check (exists (select 1 from plans p where p.id = plan_id and p.owner_id = auth.uid())
    or profile_id = auth.uid());
create policy plan_members_delete on plan_members for delete
  using (profile_id = auth.uid()
    or exists (select 1 from plans p where p.id = plan_id and p.owner_id = auth.uid()));

alter table plan_venues enable row level security;
create policy plan_venues_read on plan_venues for select
  using (exists (select 1 from plans p where p.id = plan_id
    and (p.owner_id = auth.uid()
      or exists (select 1 from plan_members m where m.plan_id = p.id and m.profile_id = auth.uid()))));
create policy plan_venues_write on plan_venues for insert
  with check (exists (select 1 from plan_members m where m.plan_id = plan_id and m.profile_id = auth.uid())
    or exists (select 1 from plans p where p.id = plan_id and p.owner_id = auth.uid()));
create policy plan_venues_delete on plan_venues for delete
  using (exists (select 1 from plans p where p.id = plan_id and p.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- chat: only participants can see/post. Meet-up tables inherit thread membership.
-- ---------------------------------------------------------------------------
alter table chat_threads enable row level security;
create policy chat_threads_read on chat_threads for select using (in_thread(id));

alter table chat_participants enable row level security;
create policy chat_participants_read on chat_participants for select
  using (in_thread(thread_id));

alter table chat_messages enable row level security;
create policy chat_messages_read on chat_messages for select using (in_thread(thread_id));
create policy chat_messages_insert on chat_messages for insert
  with check (sender_id = auth.uid() and in_thread(thread_id));

alter table meetups enable row level security;
create policy meetups_read on meetups for select using (in_thread(thread_id));

alter table meetup_options enable row level security;
create policy meetup_options_read on meetup_options for select
  using (exists (select 1 from meetups mu where mu.id = meetup_id and in_thread(mu.thread_id)));

alter table meetup_votes enable row level security;
create policy meetup_votes_read on meetup_votes for select
  using (exists (select 1 from meetups mu where mu.id = meetup_id and in_thread(mu.thread_id)));
create policy meetup_votes_write on meetup_votes for insert with check (voter_id = auth.uid());
create policy meetup_votes_update on meetup_votes for update using (voter_id = auth.uid());

alter table meetup_locations enable row level security;
-- Location shares are visible only to thread members AND only while meetup active.
create policy meetup_locations_read on meetup_locations for select
  using (exists (select 1 from meetups mu where mu.id = meetup_id
    and mu.state <> 'ended' and in_thread(mu.thread_id)));
create policy meetup_locations_write on meetup_locations for insert with check (profile_id = auth.uid());
create policy meetup_locations_update on meetup_locations for update using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- posts + offers: published, moderation-approved content is world-readable.
-- Venue owners manage their own.
-- ---------------------------------------------------------------------------
alter table posts enable row level security;
create policy posts_read_public on posts for select
  using (published_at is not null and moderation in ('auto_approved','approved'));
create policy posts_owner_all on posts for all
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()))
  with check (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

alter table offers enable row level security;
create policy offers_read on offers for select using (true);
create policy offers_owner_all on offers for all
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()))
  with check (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

alter table offer_saves enable row level security;
create policy offer_saves_own on offer_saves for all
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

alter table offer_redemptions enable row level security;
create policy redemptions_read on offer_redemptions for select
  using (profile_id = auth.uid()
    or exists (select 1 from offers o join venues v on v.id = o.venue_id
               where o.id = offer_id and v.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- notifications + push: strictly private to the recipient.
-- ---------------------------------------------------------------------------
alter table notifications enable row level security;
create policy notifications_own on notifications for select using (recipient_id = auth.uid());
create policy notifications_update_own on notifications for update using (recipient_id = auth.uid());

alter table push_subscriptions enable row level security;
create policy push_own on push_subscriptions for all
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- moderation + blocks: queue is service-role / staff only (no public policy =
-- no anon access). Users may create reports and manage their own blocks.
-- ---------------------------------------------------------------------------
alter table moderation_queue enable row level security;
create policy moderation_report on moderation_queue for insert
  with check (reason = 'user_report' and reporter_id = auth.uid());

alter table user_blocks enable row level security;
create policy blocks_own on user_blocks for all
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- ---------------------------------------------------------------------------
-- billing + push ledger: visible to the venue owner only. Writes via service role
-- (Stripe webhooks). No public write policy = clients cannot fabricate billing.
-- ---------------------------------------------------------------------------
alter table billing_customers enable row level security;
create policy billing_customers_owner on billing_customers for select
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

alter table billing_transactions enable row level security;
create policy billing_tx_owner on billing_transactions for select
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

alter table push_credit_ledger enable row level security;
create policy push_ledger_owner on push_credit_ledger for select
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Dormant seams: RLS enabled now (immune system on from birth). Owner-scoped
-- read; no live write paths until features light up. Enabling RLS on dormant
-- tables means turning them on later is a policy addition, not a security retrofit.
-- ---------------------------------------------------------------------------
alter table shop_products enable row level security;
create policy shop_products_read on shop_products for select using (active = true);
create policy shop_products_owner on shop_products for all
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()))
  with check (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

alter table shop_orders enable row level security;
create policy shop_orders_party on shop_orders for select
  using (buyer_id = auth.uid()
    or exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

alter table trips enable row level security;
create policy trips_own on trips for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table trip_stops enable row level security;
create policy trip_stops_own on trip_stops for all
  using (exists (select 1 from trips t where t.id = trip_id and t.owner_id = auth.uid()))
  with check (exists (select 1 from trips t where t.id = trip_id and t.owner_id = auth.uid()));

alter table automation_journeys enable row level security;
create policy automation_owner on automation_journeys for all
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()))
  with check (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));
