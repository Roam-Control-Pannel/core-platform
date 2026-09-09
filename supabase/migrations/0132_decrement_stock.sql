-- ============================================================================
-- 0132_decrement_stock.sql
--
-- Atomic stock decrement for the Stripe-webhook fulfilment path (#12 in the Sep 2026
-- review). The webhook decrements tracked stock with a read-modify-write:
--
--     select stock ...            -- read
--     update ... set stock = max(0, stock - qty)   -- write
--
-- Two paid webhooks for the last unit of a product can interleave between the read and
-- the write, so both see stock = 1 and both write stock = 0 — two buyers, one unit, and
-- the oversell is invisible. (Stripe also retries a webhook it thinks failed, which the
-- caller already guards against by decrementing before the best-effort inserts; but a
-- retry racing the original hits the same window.)
--
-- Fix: fold the read and the write into ONE statement guarded by a row lock. A SECURITY
-- DEFINER function takes `select stock ... for update` — the second caller blocks on the
-- lock until the first commits, then reads the already-decremented value — and classifies
-- the outcome so the caller can log a genuine oversell (demand for a unit that no longer
-- exists) without ever failing the payment confirmation.
--
-- Callable only by service_role (the webhook runs under it). EXECUTE is revoked from
-- public/anon/authenticated so a browser holding the public key cannot mutate stock
-- through this definer — RLS is bypassed inside a SECURITY DEFINER body, so the grant is
-- the only gate.
--
-- Idempotent; safe to run once on the Roam-Core project.
-- ============================================================================

drop function if exists public.decrement_stock(uuid, integer);

create function public.decrement_stock(product_id_param uuid, qty integer)
  returns table (outcome text, new_stock integer)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  current_stock integer;
  found_row boolean := false;
begin
  -- Lock the product row for the life of the transaction. A concurrent decrement of the
  -- same product blocks here until we commit, collapsing the read-modify-write race.
  select p.stock, true into current_stock, found_row
  from public.venue_products p
  where p.id = product_id_param
  for update;

  if not found_row then
    -- Product deleted between checkout and webhook — nothing to decrement.
    return query select 'missing'::text, null::integer;
    return;
  end if;

  if current_stock is null then
    -- Untracked stock (services, unlimited products) — decrement is a no-op by design.
    return query select 'untracked'::text, null::integer;
    return;
  end if;

  if qty is null or qty <= 0 then
    -- Defensive: a non-positive quantity should never reach here; leave stock untouched.
    return query select 'noop'::text, current_stock;
    return;
  end if;

  if current_stock < qty then
    -- Demand for units that no longer exist: sell down to 0 (never negative — the CHECK
    -- forbids it and a buyer paid) and report the oversell so the caller can log it.
    update public.venue_products set stock = 0 where id = product_id_param;
    return query select 'oversold'::text, 0;
    return;
  end if;

  update public.venue_products
    set stock = current_stock - qty
    where id = product_id_param;
  return query select 'decremented'::text, current_stock - qty;
end;
$$;

-- The webhook (service_role) is the only sanctioned caller. RLS does not apply inside a
-- SECURITY DEFINER body, so EXECUTE is the entire access gate — keep it off every client role.
revoke all on function public.decrement_stock(uuid, integer) from public, anon, authenticated;
grant execute on function public.decrement_stock(uuid, integer) to service_role;
