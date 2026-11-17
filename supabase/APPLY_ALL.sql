-- ============================================================================
-- ClinicStock — complete schema, apply once in the Supabase SQL Editor
-- ============================================================================
--
-- GENERATED FILE. Do not edit. It is the concatenation of:
--   supabase/migrations/0001_schema.sql
--   supabase/migrations/0002_rls.sql
--   supabase/migrations/0003_functions.sql
--   supabase/migrations/0004_onboarding.sql
-- Regenerate with: npm run sql:bundle
--
-- HOW TO APPLY
--   1. Supabase dashboard -> SQL Editor -> New query
--   2. Paste this entire file and Run
--   3. It either all succeeds or all fails: the whole file runs in one
--      transaction, so a failure half way leaves nothing behind.
--
-- WHAT IT ASSUMES
--   A fresh project. `auth.users` and the anon / authenticated / service_role
--   roles are provided by Supabase and are NOT created here.
--
-- WHAT IT DOES NOT DO
--   No seed data, no users, no clinic. Sign up through the app, then call
--   create_organization() to found your clinic -- that path is deliberately the
--   only one, so no service-role key is ever needed in the browser.
-- ============================================================================

begin;



-- ####################### 0001_schema.sql #######################

-- ============================================================================
-- 0001_schema.sql — tables, constraints and indexes (brief section 6)
-- ============================================================================
--
-- Design rules applied throughout:
--   * UUID primary keys, timestamptz for event instants, DATE for calendar
--     facts. An expiry date is a calendar fact: it is the 31st everywhere, and
--     storing it as timestamptz is how "expires tomorrow" becomes "expired" for
--     a user in another timezone.
--   * NUMERIC for money, never float. 0.1 + 0.2 <> 0.3 in binary floating
--     point, and a stock valuation that is wrong by fractions of a kobo per row
--     is wrong by real money across ten thousand rows.
--   * INTEGER for countable stock.
--   * Every tenant-owned table carries organization_id, so one RLS predicate
--     can isolate it (section 8).
-- ============================================================================

-- gen_random_uuid() has been core PostgreSQL since 13, so no extension is
-- required. Supabase also ships pgcrypto if stronger primitives are needed.

-- ---------------------------------------------------------------- enumerations

-- An enum rather than a text column with a CHECK: adding a role later is an
-- explicit migration, and a typo like 'inventory_offcier' fails at insert time
-- instead of silently creating a role that grants nothing.
create type app_role as enum ('admin', 'inventory_officer', 'viewer');

create type movement_type as enum ('receipt', 'issue', 'adjustment', 'reversal');

-- ----------------------------------------------------------------- tenancy

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  -- The clinic's own timezone, used SERVER-SIDE to work out what "today" is.
  --
  -- This is deliberately not a parameter the client passes. If the browser told
  -- us today's date, a user could claim it is last year and issue expired
  -- stock. The authoritative clock lives here; see issue_stock().
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now()
);

-- Mirrors auth.users, which belongs to Supabase and must not be altered.
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  email       text,
  created_at  timestamptz not null default now()
);

create table organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  user_id          uuid not null references profiles (id) on delete cascade,
  role             app_role not null,
  created_at       timestamptz not null default now(),
  -- One role per person per clinic. Without this a user could hold both
  -- 'viewer' and 'admin' rows, and every permission check would depend on
  -- which row the planner happened to return first.
  unique (organization_id, user_id)
);

-- --------------------------------------------------------------- catalogue

create table categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  description      text
);

-- Category names are unique per clinic, case-insensitively: "Medicines" and
-- "medicines" are the same category to a human, so they must not coexist.
create unique index categories_org_name_key
  on categories (organization_id, lower(btrim(name)));

create table suppliers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  created_at       timestamptz not null default now()
);

create table products (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  -- Deleting a category must not delete the clinic's products, so the product
  -- simply becomes uncategorised.
  category_id      uuid references categories (id) on delete set null,
  name             text not null check (length(btrim(name)) > 0),
  sku              text not null check (length(btrim(sku)) > 0),
  unit             text not null check (length(btrim(unit)) > 0),
  -- Zero is allowed and means "never flag as low". Negative would make
  -- `total <= reorder_level` unsatisfiable, so the product could never be
  -- flagged at all.
  reorder_level    integer not null default 0 check (reorder_level >= 0),
  description      text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

-- "SKU must be unique within an organisation" (section 6), case-insensitively.
-- Note it is NOT globally unique: two clinics may each run their own MED-001,
-- and that is their numbering, not a collision.
create unique index products_org_sku_key
  on products (organization_id, upper(btrim(sku)));

-- ------------------------------------------------------------------ batches

create table batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  product_id       uuid not null references products (id) on delete restrict,
  supplier_id      uuid references suppliers (id) on delete set null,
  batch_number     text not null check (length(btrim(batch_number)) > 0),

  -- THE constraint of this whole schema.
  --
  -- Even if every application check were bypassed, a batch cannot go negative.
  -- This is the last line of defence against overselling: a concurrent issue
  -- that slipped past the row lock would violate this and the transaction would
  -- abort rather than quietly record stock the clinic does not have.
  quantity_on_hand integer not null default 0 check (quantity_on_hand >= 0),

  unit_cost        numeric(14, 4) check (unit_cost is null or unit_cost >= 0),
  received_at      date not null,
  -- NULL means "no expiry recorded", which is NOT "never expires".
  expiry_date      date,
  created_at       timestamptz not null default now(),

  -- Section 7: "Flag expiry date earlier than receipt date". Stock that arrived
  -- already expired is nearly always a keying error.
  constraint batches_expiry_after_receipt
    check (expiry_date is null or expiry_date >= received_at)
);

-- "Batch number must be unique within a product" (section 6).
create unique index batches_product_number_key
  on batches (product_id, upper(btrim(batch_number)));

-- --------------------------------------------------------- movement history

create table stock_movements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  -- RESTRICT, not CASCADE: deleting a batch must not erase its history. In
  -- practice batches are never deleted, which this makes true rather than
  -- merely intended.
  batch_id         uuid not null references batches (id) on delete restrict,
  movement_type    movement_type not null,

  -- Signed: +100 received, -20 issued. Zero is not a movement, it is noise in
  -- an audit trail.
  quantity_delta   integer not null check (quantity_delta <> 0),

  reason           text,
  notes            text,
  performed_by     uuid not null references profiles (id) on delete restrict,
  created_at       timestamptz not null default now(),
  reverses_movement_id uuid references stock_movements (id) on delete restrict,

  -- A receipt's reason is generated; everything else must be explained by the
  -- person doing it. Section 7: "Require a reason for adjustments and a reason
  -- code for issue/usage."
  constraint stock_movements_reason_required
    check (
      movement_type = 'receipt'
      or (reason is not null and length(btrim(reason)) >= 3)
    ),

  -- A reversal must point at what it reverses; nothing else may.
  constraint stock_movements_reversal_target
    check (
      (movement_type = 'reversal') = (reverses_movement_id is not null)
    )
);

-- One movement can be reversed at most once. Without this, two reversals of the
-- same receipt would each subtract the quantity and the balance would be wrong
-- by exactly one delivery.
create unique index stock_movements_one_reversal_per_movement
  on stock_movements (reverses_movement_id)
  where reverses_movement_id is not null;

-- ------------------------------------------------------------------ indexes
--
-- Chosen from the queries the app actually runs, not sprinkled hopefully.
-- Every index costs write time, so each one here names its query.

-- Tenant scoping: every RLS predicate and every list screen filters on this.
create index organization_members_user_idx on organization_members (user_id);
create index products_org_idx    on products (organization_id) where is_active;
create index categories_org_idx  on categories (organization_id);
create index suppliers_org_idx   on suppliers (organization_id);

-- Product details screen: batches for one product.
create index batches_product_idx on batches (product_id);

-- Expiry reporting and the dashboard's "needs attention" list: in-date batches
-- holding stock, ordered by expiry. Partial, because empty batches are never
-- part of that question.
create index batches_org_expiry_idx
  on batches (organization_id, expiry_date)
  where quantity_on_hand > 0;

-- Movement history, newest first, per batch and per clinic.
create index stock_movements_batch_idx on stock_movements (batch_id, created_at desc);
create index stock_movements_org_idx   on stock_movements (organization_id, created_at desc);

comment on column batches.quantity_on_hand is
  'Never updated directly by a client. Changed only by the SECURITY DEFINER '
  'functions in 0003, which lock this row first. See brief section 7.';


-- ####################### 0002_rls.sql #######################

-- ============================================================================
-- 0002_rls.sql — tenant isolation, role checks and the append-only guarantee
-- ============================================================================
--
-- This file is the security boundary. Everything the browser does is advisory;
-- this is what actually decides.
--
-- Brief section 3: "Enforce permissions in PostgreSQL Row Level Security and
-- database functions, not only by hiding buttons."
-- ============================================================================

-- ------------------------------------------------- membership helper functions
--
-- WHY THESE ARE `security definer`
--
-- A policy on organization_members that queries organization_members would
-- recurse: to decide whether you may read a membership row, Postgres evaluates
-- the policy, which reads membership rows, which evaluates the policy...
-- PostgreSQL stops this with error 42P17, "infinite recursion detected in
-- policy for relation". It is the single most common way a Supabase schema
-- bricks itself.
--
-- A `security definer` function runs as its owner and is not subject to the
-- caller's RLS, so the lookup inside it terminates. The cost is that such a
-- function is a hole in RLS by design, which is why each one below is tiny,
-- read-only, and answers exactly one yes/no question.
--
-- `set search_path = ''` is not decoration either. Without it, a caller who can
-- create objects could put a malicious `organization_members` table earlier in
-- the search path and this function, running with the owner's privileges, would
-- read theirs instead. Every object below is schema-qualified for that reason.

create or replace function app_is_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function app_has_role(p_organization_id uuid, p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

comment on function app_is_member(uuid) is
  'True when the authenticated user belongs to the organisation. security '
  'definer to avoid recursive RLS evaluation on organization_members.';

-- ------------------------------------------------------- enable RLS everywhere
--
-- A policy without this line does NOTHING. Writing perfect policies and
-- forgetting to enable RLS is the number one Supabase data leak, and it fails
-- silently: the table is simply wide open.

alter table organizations        enable row level security;
alter table profiles             enable row level security;
alter table organization_members enable row level security;
alter table categories           enable row level security;
alter table suppliers            enable row level security;
alter table products             enable row level security;
alter table batches              enable row level security;
alter table stock_movements      enable row level security;

-- --------------------------------------------------------------- organizations

create policy organizations_select_members on organizations
  for select to authenticated
  using (app_is_member(id));

create policy organizations_update_admin on organizations
  for update to authenticated
  using (app_has_role(id, array['admin']::app_role[]))
  with check (app_has_role(id, array['admin']::app_role[]));

-- -------------------------------------------------------------------- profiles

-- Your own profile, plus the profiles of people you share a clinic with --
-- needed to render "performed by" in the movement history. Not every profile in
-- the database.
create policy profiles_select_self_or_colleague on profiles
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from organization_members mine
      join organization_members theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid()
        and theirs.user_id = profiles.id
    )
  );

create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- -------------------------------------------------------- organization_members

create policy members_select_same_org on organization_members
  for select to authenticated
  using (app_is_member(organization_id));

create policy members_insert_admin on organization_members
  for insert to authenticated
  with check (app_has_role(organization_id, array['admin']::app_role[]));

create policy members_update_admin on organization_members
  for update to authenticated
  using (app_has_role(organization_id, array['admin']::app_role[]))
  with check (app_has_role(organization_id, array['admin']::app_role[]));

create policy members_delete_admin on organization_members
  for delete to authenticated
  using (app_has_role(organization_id, array['admin']::app_role[]));

-- Brief section 3: "A user must not be able to grant themselves administrator
-- privileges."
--
-- The policies above already require admin to touch this table, but that is not
-- enough on its own: an admin could demote a colleague and an officer could not
-- be stopped from editing their OWN row if a future policy slipped. This
-- trigger closes the self-service route explicitly, and it runs regardless of
-- which policy let the statement through.
--
-- auth.uid() is null for the service role and for server-side seeding, which is
-- how the first admin of a clinic gets created. That path is deliberate and
-- auditable; a signed-in user never takes it.
create or replace function app_block_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;  -- service role / migration seeding
  end if;

  if tg_op = 'INSERT' and new.user_id = auth.uid() then
    raise exception 'A user cannot create their own membership.'
      using errcode = 'P0001', detail = 'PERMISSION_DENIED';
  end if;

  if tg_op = 'UPDATE' and new.user_id = auth.uid() and new.role <> old.role then
    raise exception 'A user cannot change their own role.'
      using errcode = 'P0001', detail = 'PERMISSION_DENIED';
  end if;

  return new;
end;
$$;

create trigger organization_members_no_self_elevation
  before insert or update on organization_members
  for each row execute function app_block_self_role_change();

-- ---------------------------------------------- categories, suppliers, products
--
-- Read for any member; write for admin and inventory officer; delete for admin
-- only. This is brief section 3's capability table, expressed as policy.

create policy categories_select_members on categories
  for select to authenticated using (app_is_member(organization_id));
create policy categories_write_staff on categories
  for all to authenticated
  using (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]))
  with check (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]));

create policy suppliers_select_members on suppliers
  for select to authenticated using (app_is_member(organization_id));
create policy suppliers_write_staff on suppliers
  for all to authenticated
  using (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]))
  with check (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]));

create policy products_select_members on products
  for select to authenticated using (app_is_member(organization_id));

create policy products_insert_staff on products
  for insert to authenticated
  with check (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]));

create policy products_update_staff on products
  for update to authenticated
  using (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]))
  with check (app_has_role(organization_id, array['admin','inventory_officer']::app_role[]));

create policy products_delete_admin on products
  for delete to authenticated
  using (app_has_role(organization_id, array['admin']::app_role[]));

-- ------------------------------------------------------------------- batches
--
-- READ ONLY. For everyone. Including admins.
--
-- There is exactly one policy on this table and it is `for select`. No INSERT,
-- UPDATE or DELETE policy exists, so with RLS enabled every direct write from
-- any client is refused -- not because we checked a role, but because no rule
-- permits it at all.
--
-- This is how brief section 7's critical rule stops being a convention and
-- becomes a property of the database: "Never let the frontend directly update
-- quantity_on_hand." The only way in is the SECURITY DEFINER functions in 0003,
-- which lock the row first.

create policy batches_select_members on batches
  for select to authenticated
  using (app_is_member(organization_id));

-- ------------------------------------------------------------ stock_movements
--
-- Also read only, for the same reason, plus a hard append-only guarantee below.

create policy stock_movements_select_members on stock_movements
  for select to authenticated
  using (app_is_member(organization_id));

-- Append-only, enforced for EVERY caller.
--
-- Section 8: "stock movements are append-only for normal users". This goes
-- further and blocks the service role too. The reasoning: the audit trail is
-- the clinic's protection against being blamed for a discrepancy, and a trail
-- that an operator can quietly edit protects nobody. A correction is a reversal
-- (see reverse_movement in 0003).
--
-- If history genuinely must be altered -- a GDPR erasure, say -- someone has to
-- drop this trigger in a migration, which is reviewed and recorded. That is the
-- point: make the destructive path visible rather than convenient.
create or replace function app_movements_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Stock movements cannot be % . Record a reversal instead.', lower(tg_op)
    using errcode = 'P0001', detail = 'APPEND_ONLY_VIOLATION';
end;
$$;

create trigger stock_movements_no_update
  before update on stock_movements
  for each row execute function app_movements_are_append_only();

create trigger stock_movements_no_delete
  before delete on stock_movements
  for each row execute function app_movements_are_append_only();

-- -------------------------------------------------------------------- grants
--
-- RLS narrows what a role can reach; it does not grant access in the first
-- place. Both are required: a GRANT without RLS is a leak, and RLS without a
-- GRANT is a locked door with no handle.
--
-- Note what is NOT granted: insert, update or delete on batches and
-- stock_movements. Not to anyone. Stock moves through functions only.

grant usage on schema public to authenticated;

grant select on organizations, profiles, organization_members,
                categories, suppliers, products, batches, stock_movements
  to authenticated;

grant insert, update, delete on categories, suppliers, products to authenticated;
grant insert, update, delete on organization_members to authenticated;
grant update on organizations to authenticated;
grant update on profiles to authenticated;


-- ####################### 0003_functions.sql #######################

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


-- ####################### 0004_onboarding.sql #######################

-- ============================================================================
-- 0004_onboarding.sql — how a new user gets a profile and a clinic
-- ============================================================================
--
-- Milestone 5 built the fortress and left no front door. Two problems:
--
--   1. `profiles` rows have to exist before anyone can perform a movement
--      (stock_movements.performed_by references it), but nothing creates them.
--   2. The first administrator of a clinic cannot be created by an
--      administrator, because there isn't one yet -- and the self-elevation
--      trigger in 0002 explicitly blocks inserting your own membership.
--
-- Neither can be solved with a service-role key in the browser; that key
-- bypasses RLS entirely and must never leave the server (brief section 8). So
-- both are solved with SECURITY DEFINER functions, which is the same mechanism
-- used for stock movements.
-- ============================================================================

-- ------------------------------------------------- a profile for every sign-up
--
-- Fires inside Supabase's own sign-up transaction. If this raised, the sign-up
-- itself would fail -- hence `on conflict do nothing` rather than an error on a
-- re-run.
create or replace function app_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_handle_new_user();

-- --------------------------------------------------------- founding a clinic

-- Relaxes the self-elevation rule for exactly one case: the FIRST member of a
-- brand-new organisation.
--
-- The rule in 0002 was "a user may never insert their own membership", which
-- made founding a clinic impossible. The real rule the brief wants is narrower:
--
--   "A user must not be able to grant themselves administrator privileges"
--   -- in a clinic that already exists.
--
-- Founding a clinic where you are the only member grants you power over nothing
-- but your own empty organisation. Joining one that already has members, and
-- naming your own role while doing it, is the attack. So the test becomes
-- "does this organisation already have members?" rather than "is this row
-- about me?".
create or replace function app_block_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;  -- service role / migration seeding
  end if;

  if tg_op = 'INSERT' and new.user_id = auth.uid() then
    -- Founding: permitted only while the organisation has no members at all.
    if exists (
      select 1 from public.organization_members m
      where m.organization_id = new.organization_id
    ) then
      raise exception 'You cannot add yourself to an existing clinic.'
        using errcode = 'P0001', detail = 'PERMISSION_DENIED';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.user_id = auth.uid() and new.role <> old.role then
    raise exception 'A user cannot change their own role.'
      using errcode = 'P0001', detail = 'PERMISSION_DENIED';
  end if;

  return new;
end;
$$;

-- Creates an organisation and makes the caller its administrator, atomically.
--
-- SECURITY DEFINER because `organizations` has no INSERT policy -- there is
-- deliberately no way to create a clinic by writing to the table directly, so
-- this function is the only route and it always creates the membership too.
-- A half-created clinic with no admin would be unreachable and unfixable.
create or replace function create_organization(
  p_name     text,
  p_timezone text default 'UTC'
)
returns organizations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_org   public.organizations;
begin
  if v_actor is null then
    raise exception 'You are not signed in.'
      using errcode = 'P0001', detail = 'AUTH_REQUIRED';
  end if;

  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'Enter a clinic name.'
      using errcode = 'P0001', detail = 'INVALID_INPUT';
  end if;

  -- The timezone is validated by casting: an invalid name raises here rather
  -- than silently leaving every expiry calculation on UTC.
  begin
    perform (now() at time zone coalesce(p_timezone, 'UTC'));
  exception when others then
    raise exception 'Unknown timezone: %', p_timezone
      using errcode = 'P0001', detail = 'INVALID_INPUT';
  end;

  -- The profile may not exist yet if a user was created before the trigger
  -- above was installed. Backfilled rather than failing with a foreign key
  -- error the user cannot act on.
  insert into public.profiles (id, email)
  select v_actor, u.email from auth.users u where u.id = v_actor
  on conflict (id) do nothing;

  insert into public.organizations (name, timezone)
  values (btrim(p_name), coalesce(p_timezone, 'UTC'))
  returning * into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org.id, v_actor, 'admin');

  return v_org;
end;
$$;

revoke all on function create_organization(text, text) from public;
grant execute on function create_organization(text, text) to authenticated;

-- Default categories, so a new clinic is not staring at an empty filter list.
-- Called separately rather than from create_organization: a clinic that wants
-- its own taxonomy should not have to delete ours first.
create or replace function seed_default_categories(p_organization_id uuid)
returns setof categories
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.app_has_role(
       p_organization_id, array['admin']::public.app_role[]
     ) then
    raise exception 'Only an administrator can set up categories.'
      using errcode = 'P0001', detail = 'PERMISSION_DENIED';
  end if;

  return query
  insert into public.categories (organization_id, name, description)
  values
    (p_organization_id, 'Medicines',   'Oral and injectable medicines'),
    (p_organization_id, 'Consumables', 'Single-use clinical consumables'),
    (p_organization_id, 'Equipment',   'Reusable instruments and devices')
  on conflict do nothing
  returning *;
end;
$$;

revoke all on function seed_default_categories(uuid) from public;
grant execute on function seed_default_categories(uuid) to authenticated;


commit;
