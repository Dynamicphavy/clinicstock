# Database and security model (Milestone 5)

Three migrations in `supabase/migrations/`, verified by 46 tests in
`tests/db/database.test.ts` running against real PostgreSQL 18.

```bash
npm test                       # everything: 123 passing, 2 todo
npx vitest run tests/db        # database suite only (~70s)
```

## How the layers relate

| Rule | Browser | Repository (TS) | **PostgreSQL** |
|---|---|---|---|
| Quantity > 0 | yes | yes | **yes** |
| Sufficient stock | yes | yes | **yes, under a row lock** |
| Expired batch cannot be issued | yes | yes | **yes, against the server's date** |
| Reason required | yes | yes | **yes, also a CHECK constraint** |
| Role may do this | hides UI | checks a passed-in role | **reads the role from a table** |
| Tenant isolation | — | filters by a passed-in id | **RLS using `auth.uid()`** |
| History is append-only | no edit UI | no edit method | **trigger blocks UPDATE/DELETE** |

Only the right-hand column is security. The other two are usability.

## The four decisions worth knowing

**1. `batches` and `stock_movements` have no write policy at all.**

Not "admins only" — *nobody*. One `FOR SELECT` policy each, and no INSERT /
UPDATE / DELETE grant to any role. Brief §7's "never let the frontend directly
update `quantity_on_hand`" is therefore not a convention we follow; it is a
thing the database cannot do. The only way in is the four `SECURITY DEFINER`
functions, which lock the row first.

**2. The role comes from the database, never from the request.**

`app_require_stock_role()` reads `organization_members` using `auth.uid()`,
which is the `sub` claim of a JWT Supabase has already verified. A client can
put anything in a request body; it cannot forge that claim. This is what makes
the demo's role switcher harmless and the real check real.

**3. "Today" is computed server-side from the clinic's stored timezone.**

`issue_stock` takes no `p_today` parameter, deliberately — a test asserts that
it has none. If the client supplied the date it could claim to be last year and
issue expired stock. `organizations.timezone` holds the clinic's zone, and
`app_clinic_today()` derives the date from it.

**4. Helper functions are `SECURITY DEFINER` with `search_path = ''`.**

`SECURITY DEFINER` is what stops RLS recursion: a policy on
`organization_members` that queried `organization_members` would raise error
42P17, *"infinite recursion detected in policy"*. The function runs as its owner
and is not subject to the caller's policies, so the lookup terminates.

That bypass is also a risk, which is what the empty `search_path` addresses: a
caller who can create objects could otherwise plant their own
`organization_members` table earlier in the path, and a definer-rights function
would read theirs. Every reference inside those functions is schema-qualified.

## Error codes

Functions raise `P0001` with the machine-readable code in **DETAIL** and a
clinic-readable sentence in **MESSAGE**:

```
errcode P0001 | detail INSUFFICIENT_STOCK | message "Only 30 units remain in batch PARA-A."
```

The DETAIL strings are the same values as `DomainErrorCode` in
`src/domain/errors.ts`, so the UI maps one set of codes to messages regardless
of which layer rejected the operation. Constraint violations keep their standard
SQLSTATE instead (`23505` unique, `23514` check, `42501` RLS/privilege), and the
tests assert on these specific codes — never merely that something failed.

## What is NOT verified

**The overlapping-issue concurrency test.** This is the only claim in the
security model without a behavioural test, and the gap is the harness, not the
code.

`issue_stock` does `SELECT ... FOR UPDATE` before validating, and a test asserts
that clause is present in the deployed function body. But PGlite is a single
connection: one backend process, no second session, so two transactions cannot
contend for a lock. The race cannot be reproduced here, and a passing
"concurrency test" written against this harness would be precisely the false
confidence this project has been careful to avoid.

To close it, on a real PostgreSQL server (`docker run -p 5432:5432 postgres:18`,
a local install, or a Supabase branch):

```sql
-- session 1
begin;
select quantity_on_hand from batches where id = '<batch>' for update;  -- 30, lock held

-- session 2 (must BLOCK on the next line, not error)
begin;
select issue_stock('<batch>', 20, 'Ward usage');

-- session 1
select issue_stock('<batch>', 20, 'Ward usage');   -- 30 -> 10
commit;

-- session 2 now unblocks, re-reads 10, and must fail with INSUFFICIENT_STOCK.
```

If session 2 returns successfully, there is an oversell bug. Scheduled for the
milestone 8 QA pass.

**Token verification.** The test harness recreates `auth.uid()` to Supabase's
contract, so these tests prove the *policies* are correct. They do not prove JWT
verification works — that is Supabase's code, not ours.

## Not yet connected

The application still runs on `DemoInventoryRepository` and localStorage. These
migrations are verified but not yet wired to the UI; that is milestone 6
(`SupabaseInventoryRepository` behind the same interface).

## Before any pilot with real data

Brief §8, unchanged by this milestone: Supabase Free has no automatic backups
and no production SLA. Backup frequency, retention and a **tested restore** must
be documented before a clinic's real stock records go anywhere near this.
