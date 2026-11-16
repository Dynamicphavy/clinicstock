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
