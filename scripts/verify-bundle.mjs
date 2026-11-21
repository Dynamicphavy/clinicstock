/**
 * Proves supabase/APPLY_ALL.sql applies cleanly to a fresh database before
 * anyone pastes it into a real project.
 *
 * Creates only what Supabase itself provides (the three roles, auth.users,
 * auth.uid()), then runs the bundle exactly as the SQL Editor would.
 *
 * Run: node scripts/verify-bundle.mjs
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = await PGlite.create();

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
`);

try {
  await db.exec(readFileSync("supabase/APPLY_ALL.sql", "utf8"));
  console.log("bundle applied cleanly");
} catch (e) {
  console.error("BUNDLE FAILED:", e.message);
  process.exit(1);
}

const one = async (sql) => (await db.query(sql)).rows[0].n;
console.log(
  "tables=" + (await one("select count(*)::text n from information_schema.tables where table_schema='public'")),
  "functions=" + (await one("select count(*)::text n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public'")),
  "policies=" + (await one("select count(*)::text n from pg_policies where schemaname='public'")),
  "rls_tables=" + (await one("select count(*)::text n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relrowsecurity")),
  "triggers=" + (await one("select count(*)::text n from pg_trigger where not tgisinternal")),
);

// Every tenant table must have RLS on. A table added later without it is the
// classic silent leak, so this is checked rather than assumed.
const unprotected = await db.query(
  `select c.relname from pg_class c
   join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
);
if (unprotected.rows.length > 0) {
  console.error("TABLES WITHOUT RLS:", unprotected.rows.map((r) => r.relname).join(", "));
  process.exit(1);
}
console.log("every public table has row level security enabled");

// 0005: anon must hold no privileges on application tables or functions.
// Supabase's default privileges grant them automatically, so this is checked
// rather than trusted -- it is the exact divergence that let the live project
// run on one lock instead of two.
const anonTables = await db.query(
  `select table_name from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'`,
);
if (anonTables.rows.length > 0) {
  console.error("anon STILL HAS TABLE GRANTS:", [...new Set(anonTables.rows.map((r) => r.table_name))].join(", "));
  process.exit(1);
}

const anonFns = await db.query(
  `select p.proname from pg_proc p
   join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and has_function_privilege('anon', p.oid, 'execute')`,
);
if (anonFns.rows.length > 0) {
  console.error("anon CAN STILL EXECUTE:", anonFns.rows.map((r) => r.proname).join(", "));
  process.exit(1);
}
console.log("anon holds no table or function privileges");

// And the two tables that must never be writable by anyone.
const writable = await db.query(
  `select distinct table_name, privilege_type
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('batches', 'stock_movements')
     -- TRUNCATE included: it skips row-level triggers, so holding it would
     -- bypass the append-only rule entirely.
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     and grantee in ('anon', 'authenticated')`,
);
if (writable.rows.length > 0) {
  console.error("STOCK TABLES ARE WRITABLE:", writable.rows.map((r) => r.table_name + "/" + r.privilege_type).join(", "));
  process.exit(1);
}
console.log("batches and stock_movements have no write grant for any client role");

await db.close();
