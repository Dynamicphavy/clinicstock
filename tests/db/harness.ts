/**
 * PostgreSQL test harness.
 *
 * Runs the real migrations against a real PostgreSQL 18 engine (PGlite, which
 * is PostgreSQL compiled to WebAssembly) so the policies and functions under
 * test are the exact SQL that will be deployed -- not a reimplementation of
 * them in TypeScript.
 *
 * WHAT THIS HARNESS FAKES, AND WHY IT IS HONEST TO DO SO
 *
 * Supabase provides three things our migrations depend on but do not create:
 *   * the `anon`, `authenticated` and `service_role` database roles;
 *   * the `auth.users` table;
 *   * `auth.uid()`, which reads the `sub` claim of the verified JWT.
 *
 * The shim below recreates those to Supabase's documented contract. That is the
 * ONE place this differs from production, and it matters: `auth.uid()` here
 * returns whatever we put in `request.jwt.claims`, whereas in production the
 * claim arrives inside a token Supabase has cryptographically verified. So
 * these tests prove the POLICIES are right; they do not prove token
 * verification works, which is Supabase's job.
 *
 * WHAT THIS HARNESS CANNOT DO
 *
 * PGlite is a single connection. There is no second backend process, so two
 * transactions cannot contend for a row lock. The `SELECT ... FOR UPDATE`
 * concurrency test therefore cannot run here, and it is left as an explicit
 * `todo` rather than faked -- see tests/database.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = ["0001_schema.sql", "0002_rls.sql", "0003_functions.sql"];

/** Recreates the parts of a Supabase project our migrations rely on. */
const SUPABASE_SHIM = `
  create role anon;
  create role authenticated;
  create role service_role;

  create schema if not exists auth;

  create table auth.users (
    id    uuid primary key,
    email text
  );

  -- Supabase's own definition: the 'sub' claim of the verified JWT.
  -- Passing true as the second argument to current_setting means 'return null
  -- if unset' rather than raising -- which is how an unauthenticated request
  -- and the service role both end up with auth.uid() = null.
  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    -- nullif the SETTING before casting. An anonymous request leaves the
    -- claim unset (null); our tests clear it to an empty string. Casting ''
    -- to jsonb raises 'The input string ended unexpectedly', so both cases
    -- have to collapse to null BEFORE the cast.
    select (
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid;
  $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant select on auth.users to authenticated;
`;

/* Fixed ids so failures name something recognisable rather than a random uuid. */
export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";

export const ADMIN_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const OFFICER_A = "aaaaaaaa-0000-4000-8000-000000000002";
export const VIEWER_A = "aaaaaaaa-0000-4000-8000-000000000003";
export const ADMIN_B = "bbbbbbbb-0000-4000-8000-000000000001";

export const PRODUCT_A = "cccccccc-0000-4000-8000-000000000001";
export const PRODUCT_B = "cccccccc-0000-4000-8000-000000000002";

export const BATCH_A_GOOD = "dddddddd-0000-4000-8000-000000000001";
export const BATCH_A_EXPIRED = "dddddddd-0000-4000-8000-000000000002";
export const BATCH_B = "dddddddd-0000-4000-8000-000000000003";

/**
 * Seed data, inserted as the session superuser.
 *
 * That is the production equivalent of the service role: RLS is bypassed and
 * `auth.uid()` is null, which is exactly how a clinic's first administrator
 * gets created. The self-elevation trigger allows it for that reason.
 *
 * Balances and movements are inserted together so the audit invariant (deltas
 * sum to quantity_on_hand) holds from the very first row.
 */
const SEED = `
  insert into organizations (id, name, timezone) values
    ('${ORG_A}', 'Clinic A', 'Africa/Lagos'),
    ('${ORG_B}', 'Clinic B', 'UTC');

  insert into auth.users (id, email) values
    ('${ADMIN_A}',   'admin.a@example.test'),
    ('${OFFICER_A}', 'officer.a@example.test'),
    ('${VIEWER_A}',  'viewer.a@example.test'),
    ('${ADMIN_B}',   'admin.b@example.test');

  insert into profiles (id, full_name, email) values
    ('${ADMIN_A}',   'Admin A',   'admin.a@example.test'),
    ('${OFFICER_A}', 'Officer A', 'officer.a@example.test'),
    ('${VIEWER_A}',  'Viewer A',  'viewer.a@example.test'),
    ('${ADMIN_B}',   'Admin B',   'admin.b@example.test');

  insert into organization_members (organization_id, user_id, role) values
    ('${ORG_A}', '${ADMIN_A}',   'admin'),
    ('${ORG_A}', '${OFFICER_A}', 'inventory_officer'),
    ('${ORG_A}', '${VIEWER_A}',  'viewer'),
    ('${ORG_B}', '${ADMIN_B}',   'admin');

  insert into categories (id, organization_id, name) values
    ('eeeeeeee-0000-4000-8000-000000000001', '${ORG_A}', 'Medicines');

  -- Both clinics use SKU MED-001. That is not a conflict: SKU is unique per
  -- organisation, and these tests prove it.
  insert into products (id, organization_id, category_id, name, sku, unit, reorder_level) values
    ('${PRODUCT_A}', '${ORG_A}', 'eeeeeeee-0000-4000-8000-000000000001',
     'Paracetamol 500mg', 'MED-001', 'tablet', 100),
    ('${PRODUCT_B}', '${ORG_B}', null,
     'Clinic B paracetamol', 'MED-001', 'tablet', 50);

  insert into batches (id, organization_id, product_id, batch_number,
                       quantity_on_hand, received_at, expiry_date) values
    ('${BATCH_A_GOOD}',    '${ORG_A}', '${PRODUCT_A}', 'PARA-A', 30,
     current_date - 30, current_date + 90),
    ('${BATCH_A_EXPIRED}', '${ORG_A}', '${PRODUCT_A}', 'PARA-OLD', 40,
     current_date - 400, current_date - 1),
    ('${BATCH_B}',         '${ORG_B}', '${PRODUCT_B}', 'B-PARA-1', 55,
     current_date - 10, current_date + 200);

  insert into stock_movements (organization_id, batch_id, movement_type,
                              quantity_delta, reason, performed_by) values
    ('${ORG_A}', '${BATCH_A_GOOD}',    'receipt', 30, 'Opening stock', '${ADMIN_A}'),
    ('${ORG_A}', '${BATCH_A_EXPIRED}', 'receipt', 40, 'Opening stock', '${ADMIN_A}'),
    ('${ORG_B}', '${BATCH_B}',         'receipt', 55, 'Opening stock', '${ADMIN_B}');
`;

export async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_SHIM);
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8");
    await db.exec(sql);
  }
  await db.exec(SEED);
  return db;
}

/**
 * Run queries as a signed-in user.
 *
 * `set role authenticated` is essential: the session user is a superuser, and
 * superusers BYPASS row level security entirely. A test that forgets this line
 * passes while proving nothing -- the most dangerous kind of green.
 */
export async function asUser<T>(
  db: PGlite,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec(
    `select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
     set role authenticated;`,
  );
  try {
    return await fn();
  } finally {
    await db.exec(
      `reset role;
       select set_config('request.jwt.claims', '', false);`,
    );
  }
}

export interface CapturedError {
  message: string;
  /** Our machine-readable DomainErrorCode, carried in the SQL DETAIL field. */
  detail: string;
  code: string;
}

/** Captures a rejection so a test can assert on the specific code, not just
 *  that "something failed" -- the lesson from the broken expired-batch test. */
export async function expectFailure(fn: () => Promise<unknown>): Promise<CapturedError> {
  try {
    await fn();
  } catch (e) {
    const err = e as { message?: string; detail?: string; code?: string };
    return {
      message: err.message ?? "",
      detail: err.detail ?? "",
      code: err.code ?? "",
    };
  }
  throw new Error("Expected this operation to fail, but it succeeded.");
}
