-- ============================================================================
-- 0005_harden.sql — two flaws found by probing the real project
-- ============================================================================
--
-- Both were invisible to the 132 local tests. They are worth reading as a pair,
-- because they failed in opposite directions: one is a divergence between the
-- test environment and production, the other is a hole the tests never asked
-- about.
--
-- ---------------------------------------------------------------------------
-- FLAW 1: Supabase grants new public tables to `anon` automatically.
-- ---------------------------------------------------------------------------
-- A hosted project ships with
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role;
-- so every table 0001 created was reachable by the anonymous role the moment it
-- existed. Probing the live project with only the publishable key returned
-- `200 []` on products, and an INSERT returned 42501 -- "row level security"
-- rather than "permission denied for table".
--
-- Nothing leaked: RLS refused every row and every write, exactly as designed.
-- But the design had TWO locks and production was running on one. 0002 says
-- "a GRANT without RLS is a leak, and RLS without a GRANT is a locked door with
-- no handle" -- and then relied on a grant that a hosted project quietly
-- widened. The local tests passed because PGlite has no such default.
--
-- ---------------------------------------------------------------------------
-- FLAW 2: the stock functions looked up rows before checking authentication.
-- ---------------------------------------------------------------------------
-- Calling issue_stock with no JWT and a random UUID answered BATCH_NOT_FOUND.
-- An unauthenticated caller could therefore tell a real batch id from a fake
-- one: a real one in someone else's clinic answered PERMISSION_DENIED instead.
-- That is an existence oracle, served to a caller who has not signed in.
--
-- Worse, a test in milestone 5 asserted the PERMISSION_DENIED case and its
-- comment claimed the caller "learns nothing about whether it exists". That was
-- backwards: PERMISSION_DENIED tells them it DOES exist. The test passed
-- because it used a real batch id; nobody asked what happens with a fake one.
--
-- Fixed here in two parts:
--   a) authentication is checked FIRST, before any row is read;
--   b) a row in another clinic is reported as NOT FOUND, identically to a row
--      that does not exist -- the "404, not 403" rule. A caller learns nothing
--      either way.
-- ============================================================================

-- ------------------------------------------------- part 1: close the grants

-- Revoke everything, then re-grant precisely what sections 3 and 7 call for.
-- service_role is left alone: it is Supabase's own server-side identity and
-- bypasses RLS by design.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on schema public from anon;

-- Functions need `from public`, NOT `from anon`.
--
-- PostgreSQL grants EXECUTE on every new function to the PUBLIC pseudo-role,
-- which every role including anon inherits. Revoking from anon by name leaves
-- that inherited grant untouched, so anon could still execute the membership
-- helpers. The verify script caught this after the first version of this
-- migration -- `revoke ... from anon` is not the same statement as
-- `revoke ... from public`.
revoke all on all functions in schema public from public, anon, authenticated;

-- Stop the defaults re-opening the door for any table a later migration adds.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- `anon` is the pre-login identity. It needs the auth endpoints and nothing
-- else -- the login screen reads no tables.
grant usage on schema public to authenticated;

grant select on organizations, profiles, organization_members,
                categories, suppliers, products, batches, stock_movements
  to authenticated;

grant insert, update, delete on categories, suppliers, products to authenticated;
grant insert, update, delete on organization_members to authenticated;
grant update on organizations to authenticated;
grant update on profiles to authenticated;

-- Still no write grant on batches or stock_movements, for anybody. Both locks
-- are now actually in place: no grant AND no policy.

-- These two are called from inside RLS POLICY expressions, which are evaluated
-- with the invoking user's privileges -- so `authenticated` genuinely needs
-- EXECUTE on them or every policy fails. The rest (app_clinic_today,
-- app_require_stock_role, app_require_auth) are only ever called from inside
-- SECURITY DEFINER functions, which run as the owner, so they need no grant.
grant execute on function app_is_member(uuid) to authenticated;
grant execute on function app_has_role(uuid, app_role[]) to authenticated;

grant execute on function receive_stock(uuid, text, integer, date, date, numeric, uuid, text) to authenticated;
grant execute on function issue_stock(uuid, integer, text, text) to authenticated;
grant execute on function adjust_stock(uuid, integer, text, text) to authenticated;
grant execute on function reverse_movement(uuid, text) to authenticated;
grant execute on function create_organization(text, text) to authenticated;
grant execute on function seed_default_categories(uuid) to authenticated;

-- ------------------------------------- part 2: authenticate before disclosing

-- Signed in, or nothing happens. Separated from app_require_stock_role so it
-- can run before any table is touched.
create or replace function app_require_auth()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'You are not signed in.'
      using errcode = 'P0001', detail = 'AUTH_REQUIRED';
  end if;
  return v_actor;
end;
$$;

create or replace function issue_stock(
  p_batch_id  uuid,
  p_quantity  integer,
  p_reason    text,
  p_notes     text default null
)
returns batches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch public.batches;
  v_actor uuid;
  v_today date;
begin
  -- FIRST. Before input validation, before the row lookup, before anything
  -- that could tell an anonymous caller what exists.
  v_actor := public.app_require_auth();

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero.'
      using errcode = 'P0001', detail = 'QUANTITY_NOT_POSITIVE';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason of at least 3 characters.'
      using errcode = 'P0001', detail = 'REASON_REQUIRED';
  end if;

  -- The lock. See 0003 for why this clause is the one that prevents
  -- overselling; nothing about that has changed.
  select * into v_batch
  from public.batches b
  where b.id = p_batch_id
  for update;

  -- "Not found" and "not yours" are reported identically. A caller who guesses
  -- a UUID from another clinic learns exactly as much as one who invents a
  -- UUID: nothing.
  if not found
     or not public.app_is_member(v_batch.organization_id) then
    raise exception 'That batch no longer exists.'
      using errcode = 'P0001', detail = 'BATCH_NOT_FOUND';
  end if;

  -- Member, but is the ROLE allowed to move stock? Only now is it safe to
  -- distinguish this, because we already know the caller belongs here.
  perform public.app_require_stock_role(v_batch.organization_id);

  v_today := public.app_clinic_today(v_batch.organization_id);

  if v_batch.expiry_date is not null and v_batch.expiry_date < v_today then
    raise exception 'Batch % has expired and cannot be issued.', v_batch.batch_number
      using errcode = 'P0001', detail = 'BATCH_EXPIRED';
  end if;

  if p_quantity > v_batch.quantity_on_hand then
    raise exception 'Only % units remain in batch %.',
      v_batch.quantity_on_hand, v_batch.batch_number
      using errcode = 'P0001', detail = 'INSUFFICIENT_STOCK';
  end if;

  update public.batches
  set quantity_on_hand = quantity_on_hand - p_quantity
  where id = v_batch.id
  returning * into v_batch;

  insert into public.stock_movements (
    organization_id, batch_id, movement_type, quantity_delta,
    reason, notes, performed_by
  )
  values (
    v_batch.organization_id, v_batch.id, 'issue', -p_quantity,
    btrim(p_reason), p_notes, v_actor
  );

  return v_batch;
end;
$$;

create or replace function adjust_stock(
  p_batch_id       uuid,
  p_quantity_delta integer,
  p_reason         text,
  p_notes          text default null
)
returns batches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch public.batches;
  v_actor uuid;
begin
  v_actor := public.app_require_auth();

  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'Adjustment cannot be zero.'
      using errcode = 'P0001', detail = 'DELTA_ZERO';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason of at least 3 characters.'
      using errcode = 'P0001', detail = 'REASON_REQUIRED';
  end if;

  select * into v_batch from public.batches b where b.id = p_batch_id for update;

  if not found or not public.app_is_member(v_batch.organization_id) then
    raise exception 'That batch no longer exists.'
      using errcode = 'P0001', detail = 'BATCH_NOT_FOUND';
  end if;

  perform public.app_require_stock_role(v_batch.organization_id);

  -- Still no expiry check: writing off expired stock IS an adjustment.
  if v_batch.quantity_on_hand + p_quantity_delta < 0 then
    raise exception
      'That would leave a negative balance. Batch % holds % units.',
      v_batch.batch_number, v_batch.quantity_on_hand
      using errcode = 'P0001', detail = 'INSUFFICIENT_STOCK';
  end if;

  update public.batches
  set quantity_on_hand = quantity_on_hand + p_quantity_delta
  where id = v_batch.id
  returning * into v_batch;

  insert into public.stock_movements (
    organization_id, batch_id, movement_type, quantity_delta,
    reason, notes, performed_by
  )
  values (
    v_batch.organization_id, v_batch.id, 'adjustment', p_quantity_delta,
    btrim(p_reason), p_notes, v_actor
  );

  return v_batch;
end;
$$;

create or replace function receive_stock(
  p_product_id    uuid,
  p_batch_number  text,
  p_quantity      integer,
  p_received_at   date,
  p_expiry_date   date default null,
  p_unit_cost     numeric default null,
  p_supplier_id   uuid default null,
  p_notes         text default null
)
returns batches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_actor  uuid;
  v_batch  public.batches;
  v_active boolean;
begin
  v_actor := public.app_require_auth();

  select p.organization_id, p.is_active into v_org, v_active
  from public.products p
  where p.id = p_product_id;

  -- Same rule: another clinic's product is reported as absent.
  if v_org is null or not public.app_is_member(v_org) then
    raise exception 'That product no longer exists.'
      using errcode = 'P0001', detail = 'PRODUCT_NOT_FOUND';
  end if;

  perform public.app_require_stock_role(v_org);

  if not v_active then
    raise exception 'This product is inactive. Reactivate it before receiving stock.'
      using errcode = 'P0001', detail = 'PRODUCT_INACTIVE';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero.'
      using errcode = 'P0001', detail = 'QUANTITY_NOT_POSITIVE';
  end if;

  if p_expiry_date is not null and p_expiry_date < p_received_at then
    raise exception 'Expiry date is before the receipt date. Check the dates.'
      using errcode = 'P0001', detail = 'EXPIRY_BEFORE_RECEIPT';
  end if;

  select * into v_batch
  from public.batches b
  where b.product_id = p_product_id
    and upper(btrim(b.batch_number)) = upper(btrim(p_batch_number))
  for update;

  if found then
    if coalesce(v_batch.expiry_date, 'infinity'::date)
       is distinct from coalesce(p_expiry_date, 'infinity'::date) then
      raise exception
        'Batch % already exists for this product with a different expiry date.',
        v_batch.batch_number
        using errcode = 'P0001', detail = 'DUPLICATE_BATCH_NUMBER';
    end if;

    update public.batches
    set quantity_on_hand = quantity_on_hand + p_quantity
    where id = v_batch.id
    returning * into v_batch;
  else
    insert into public.batches (
      organization_id, product_id, supplier_id, batch_number,
      quantity_on_hand, unit_cost, received_at, expiry_date
    )
    values (
      v_org, p_product_id, p_supplier_id, btrim(p_batch_number),
      p_quantity, p_unit_cost, p_received_at, p_expiry_date
    )
    returning * into v_batch;
  end if;

  insert into public.stock_movements (
    organization_id, batch_id, movement_type, quantity_delta,
    reason, notes, performed_by
  )
  values (
    v_org, v_batch.id, 'receipt', p_quantity,
    'Stock received', p_notes, v_actor
  );

  return v_batch;
end;
$$;

create or replace function reverse_movement(
  p_movement_id uuid,
  p_reason      text
)
returns batches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_original public.stock_movements;
  v_batch    public.batches;
  v_actor    uuid;
  v_delta    integer;
begin
  v_actor := public.app_require_auth();

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason of at least 3 characters.'
      using errcode = 'P0001', detail = 'REASON_REQUIRED';
  end if;

  select * into v_original
  from public.stock_movements m
  where m.id = p_movement_id;

  if not found or not public.app_is_member(v_original.organization_id) then
    raise exception 'That movement no longer exists.'
      using errcode = 'P0001', detail = 'MOVEMENT_NOT_FOUND';
  end if;

  perform public.app_require_stock_role(v_original.organization_id);

  if v_original.movement_type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'P0001', detail = 'INVALID_INPUT';
  end if;

  select * into v_batch
  from public.batches b
  where b.id = v_original.batch_id
  for update;

  v_delta := -v_original.quantity_delta;

  if v_batch.quantity_on_hand + v_delta < 0 then
    raise exception
      'Reversing this movement would leave a negative balance -- the stock has already been issued.'
      using errcode = 'P0001', detail = 'INSUFFICIENT_STOCK';
  end if;

  update public.batches
  set quantity_on_hand = quantity_on_hand + v_delta
  where id = v_batch.id
  returning * into v_batch;

  insert into public.stock_movements (
    organization_id, batch_id, movement_type, quantity_delta,
    reason, notes, performed_by, reverses_movement_id
  )
  values (
    v_batch.organization_id, v_batch.id, 'reversal', v_delta,
    btrim(p_reason), null, v_actor, p_movement_id
  );

  return v_batch;
end;
$$;

revoke all on function app_require_auth() from public;
