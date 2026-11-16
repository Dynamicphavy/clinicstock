-- ============================================================================
-- 0003_functions.sql — transactional stock movements
-- ============================================================================
--
-- Brief section 7, the critical implementation rule:
--
--   "Implement PostgreSQL functions that verify organisation membership and
--    role, lock the batch row, validate quantity and expiry, update the
--    balance, insert the movement and commit both changes atomically."
--
-- Every function below follows that order exactly. The order matters: locking
-- before validating is the whole point, because a check made before the lock is
-- a check made against a value that can change before the write.
--
-- ERROR CONVENTION
--   errcode 'P0001', with a machine-readable code in DETAIL and a
--   clinic-readable sentence in MESSAGE. The DETAIL codes are the same strings
--   as DomainErrorCode in src/domain/errors.ts, so the UI maps one set of codes
--   to messages regardless of which layer rejected the operation.
-- ============================================================================

-- Today, according to the CLINIC, computed server-side.
--
-- Not a parameter. If the client supplied today's date, a user could claim it
-- is last year and issue expired stock -- the same "never trust a value the
-- client controls" rule that makes RLS use auth.uid() rather than an id from
-- the request.
create or replace function app_clinic_today(p_organization_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone coalesce(o.timezone, 'UTC'))::date
  from public.organizations o
  where o.id = p_organization_id;
$$;

-- Shared preamble: who is acting, and may they move stock in this clinic?
create or replace function app_require_stock_role(p_organization_id uuid)
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

  -- Membership and role are read from the database, never from the request.
  -- This is the check that makes the browser's hidden buttons irrelevant.
  if not public.app_has_role(
       p_organization_id,
       array['admin','inventory_officer']::public.app_role[]
     ) then
    raise exception 'Your role cannot change stock levels.'
      using errcode = 'P0001', detail = 'PERMISSION_DENIED';
  end if;

  return v_actor;
end;
$$;

-- ---------------------------------------------------------------- receive_stock

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
  -- The organisation comes from the PRODUCT, not from the caller. A caller who
  -- passed their own organization_id could otherwise attach stock to someone
  -- else's product.
  select p.organization_id, p.is_active into v_org, v_active
  from public.products p
  where p.id = p_product_id;

  if v_org is null then
    raise exception 'That product no longer exists.'
      using errcode = 'P0001', detail = 'PRODUCT_NOT_FOUND';
  end if;

  v_actor := public.app_require_stock_role(v_org);

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

  -- Existing batch number for this product? Top it up rather than create a
  -- second row, so one physical consignment keeps one balance and one expiry
  -- date. FOR UPDATE because two deliveries of the same batch arriving at once
  -- would otherwise race.
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

  -- Same transaction as the balance change. Either both land or neither does,
  -- so the history can never disagree with the balance.
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

-- ------------------------------------------------------------------ issue_stock

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
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero.'
      using errcode = 'P0001', detail = 'QUANTITY_NOT_POSITIVE';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason of at least 3 characters.'
      using errcode = 'P0001', detail = 'REASON_REQUIRED';
  end if;

  -- ======================================================================
  -- THE LOCK. This single clause is what prevents overselling.
  --
  -- Two officers each issuing 20 from a batch of 30, at the same instant:
  --
  --   without FOR UPDATE   read 30 | read 30 | both ok | both write 10
  --                        -> 40 units leave, the system says 20, the shelf
  --                           is short and the history is a lie.
  --
  --   with FOR UPDATE      txn A locks the row and proceeds.
  --                        txn B BLOCKS here -- it does not read stale data
  --                        and it does not error. It waits.
  --                        A commits 10. B wakes, re-reads 10, finds 20 > 10,
  --                        and is correctly rejected.
  --
  -- No amount of frontend validation can do this, because the race happens
  -- BETWEEN the check and the write. Only the database can hold that gap shut.
  -- ======================================================================
  select * into v_batch
  from public.batches b
  where b.id = p_batch_id
  for update;

  if not found then
    raise exception 'That batch no longer exists.'
      using errcode = 'P0001', detail = 'BATCH_NOT_FOUND';
  end if;

  -- Role check AFTER the lock but BEFORE any write. Note it also answers "is
  -- this batch even mine?" -- a caller from another clinic holds no role in
  -- this organisation, so they are refused with PERMISSION_DENIED and learn
  -- nothing about whether the batch exists.
  v_actor := public.app_require_stock_role(v_batch.organization_id);

  v_today := public.app_clinic_today(v_batch.organization_id);

  -- Expired stock stays visible for audit but can never be issued (section 7).
  if v_batch.expiry_date is not null and v_batch.expiry_date < v_today then
    raise exception 'Batch % has expired and cannot be issued.', v_batch.batch_number
      using errcode = 'P0001', detail = 'BATCH_EXPIRED';
  end if;

  -- Re-read value, not the one the client saw. This is the comparison the lock
  -- exists to protect.
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

-- ----------------------------------------------------------------- adjust_stock

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
  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'Adjustment cannot be zero.'
      using errcode = 'P0001', detail = 'DELTA_ZERO';
  end if;

  -- Mandatory, no exceptions. An adjustment without a reason is an unexplained
  -- stock change, which is exactly what the audit trail exists to prevent.
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason of at least 3 characters.'
      using errcode = 'P0001', detail = 'REASON_REQUIRED';
  end if;

  select * into v_batch from public.batches b where b.id = p_batch_id for update;

  if not found then
    raise exception 'That batch no longer exists.'
      using errcode = 'P0001', detail = 'BATCH_NOT_FOUND';
  end if;

  v_actor := public.app_require_stock_role(v_batch.organization_id);

  -- Deliberately NO expiry check here.
  --
  -- Writing off expired stock IS an adjustment. Blocking it would trap expired
  -- units on the books forever: unissuable because they are expired, and
  -- unremovable because we refused the only mechanism that removes them.
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

-- -------------------------------------------------------------- reverse_movement

-- A compensating entry. The original row is never touched -- the append-only
-- triggers in 0002 make that true even for the service role.
--
-- This is the mechanism behind "correct errors with a reversal or adjustment
-- entry" (section 3) and it is what protects staff: history shows the mistake
-- AND the correction, so a typo cannot look like theft.
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
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Give a reason of at least 3 characters.'
      using errcode = 'P0001', detail = 'REASON_REQUIRED';
  end if;

  select * into v_original
  from public.stock_movements m
  where m.id = p_movement_id;

  if not found then
    raise exception 'That movement no longer exists.'
      using errcode = 'P0001', detail = 'MOVEMENT_NOT_FOUND';
  end if;

  if v_original.movement_type = 'reversal' then
    raise exception 'A reversal cannot itself be reversed.'
      using errcode = 'P0001', detail = 'INVALID_INPUT';
  end if;

  select * into v_batch
  from public.batches b
  where b.id = v_original.batch_id
  for update;

  v_actor := public.app_require_stock_role(v_batch.organization_id);

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

  -- The unique index from 0001 makes a second reversal of the same movement
  -- impossible; this insert is where that constraint bites.
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

-- ------------------------------------------------------------------- execution
--
-- `security definer` functions run with their owner's privileges, so EXECUTE
-- must be granted deliberately and nothing else should have it.

revoke all on function receive_stock(uuid, text, integer, date, date, numeric, uuid, text) from public;
revoke all on function issue_stock(uuid, integer, text, text) from public;
revoke all on function adjust_stock(uuid, integer, text, text) from public;
revoke all on function reverse_movement(uuid, text) from public;

grant execute on function receive_stock(uuid, text, integer, date, date, numeric, uuid, text) to authenticated;
grant execute on function issue_stock(uuid, integer, text, text) to authenticated;
grant execute on function adjust_stock(uuid, integer, text, text) to authenticated;
grant execute on function reverse_movement(uuid, text) to authenticated;
