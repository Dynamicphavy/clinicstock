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
