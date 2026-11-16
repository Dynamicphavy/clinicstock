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
