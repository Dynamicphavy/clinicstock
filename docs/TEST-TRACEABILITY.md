# Test traceability — brief §11

Every row of the brief's acceptance table, and where it is verified.
Run the suite with `npm test`.

Status during Milestone 8: **174 passing, 2 deliberately deferred**, stable
across three shuffled-order runs (`npm run test:shuffle`), in about 7 to 11
seconds.

## Milestone 8 finding: the suite disagreed with itself

The first clean re-run of Milestone 8 gave two different answers for the same
commit: one run had its worker OOM-killed, the next failed 3 tests with no
assertion message, one of them after 891 seconds. Cause: a fresh PostgreSQL
(PGlite) per test, 62 of them, on a 3.7 GB machine whose swap had been filled
by two dev servers an earlier session left running.

A suite that gives different answers to the same question certifies nothing,
so it was fixed before anything else in Milestone 8:

- One database per file, restored before each test by `resetDb()`, which
  resets the session role, the JWT claim and any aborted transaction, not just
  the rows. It uses TRUNCATE because our own append-only trigger refuses DELETE.
- `fingerprint()` hashes rows, grants, policies, triggers and session identity.
  A test asserts that a dirtied-then-reset database matches a freshly built
  one, and a control test proves the fingerprint changes on a single leftover
  row.
- Shuffled runs are the evidence that no test depends on another's leftovers.
- Side effect: TRUNCATE skips row-level triggers, so append-only depends on no
  client holding it. That is now asserted in the suite and in
  `scripts/verify-bundle.mjs`.

| § 11 test | Expected result | Covered by | Status |
|---|---|---|---|
| Add product | Appears in inventory | `tests/repository.test.ts` → "appears in inventory afterwards" | pass |
| Duplicate SKU | Rejected within the same clinic | "rejects a duplicate SKU", "case-insensitive" | pass |
| Receive 100 units | Balance +100, receipt recorded | "receiving 100 units increases the balance" | pass |
| Issue 20 units | Batch −20, issue recorded | "issuing 20 units decreases the batch" | pass |
| Issue more than available | Rejected, balance unchanged | "rejects issuing more than available" | pass |
| Adjustment −5 | Balance −5, reason + actor recorded | "an adjustment of -5 decreases the balance" | pass |
| Adjustment without reason | Rejected | "rejects an adjustment with no reason" | pass |
| Add second batch | Product total recalculates | "adding a second batch recalculates the product total" | pass |
| Expired batch issue | Rejected | "rejects issuing from an expired batch" | pass |
| FEFO recommendation | Earliest-expiring eligible batch | `tests/stock.test.ts` → 7 FEFO cases | pass |
| Expiry tomorrow | Expiring soon | `tests/expiry.test.ts` | pass |
| Expiry 45 days away | Approaching expiry | `tests/expiry.test.ts` | pass |
| Expiry date in past | Expired | `tests/expiry.test.ts` | pass |
| No expiry date | No expiry recorded | `tests/expiry.test.ts` | pass |
| Viewer tries to change stock | **Database** rejects it | `tests/db/database.test.ts` → "a viewer cannot receive, issue or adjust stock" | **pass** |
| Clinic A queries Clinic B | No data returned | `tests/db/database.test.ts` → "Clinic B queries Clinic A and gets NOTHING" | **pass** |
| Concurrent stock issue | No overselling | `FOR UPDATE` implemented + presence asserted; overlap test needs two connections | **partial** |
| CSV/PDF export | Correct filtered data and totals | `tests/reports.test.ts` (31 tests) | **pass** |

Milestone 4 added `tests/inventoryView.test.ts` (14 tests) covering the numbers
the screens display: row roll-ups, most-urgent status, total vs usable stock,
active-only counts and search. These are not §11 rows, but they are where a
"three screens disagree about the same number" bug would appear -- and the
milestone 7 exports read the same functions, so the export totals cannot drift
from the table.

## Milestone 5 added 46 database tests

Run against real PostgreSQL 18, exercising the deployed migrations: schema
constraints, RLS tenant isolation, the absence of any write policy on `batches`
and `stock_movements`, the append-only triggers, all four stock functions, role
enforcement and the self-elevation guard. `docs/DATABASE.md` explains the model
and the one remaining gap.

Two findings came out of writing them, both worth recording:

1. **A test of mine was wrong, not the code.** Reversing the opening receipt
   twice returned `INSUFFICIENT_STOCK`, not the unique-index violation I
   expected — because undoing a +30 receipt twice would drive the balance to
   −30, so the negative-balance guard fires first. Check order matters, and
   asserting a *specific* error code is what surfaced it.
2. **The harness shim had a bug.** Clearing `request.jwt.claims` to `''` made
   `auth.uid()` raise on the jsonb cast instead of returning null. Real Supabase
   leaves the claim unset; the shim now collapses both cases before casting.

## What has no automated coverage at all

The signed-in client path. Milestone 6 was verified by a person clicking
through sign-up, clinic creation, product entry, receipt, issue and history
against the live project on 2026-11-18, and it all worked -- but a manual pass
is not a test. It does not survive a refactor, it does not run in CI, and it
proves the code worked once rather than that it works.

The gap is specific: `SupabaseInventoryRepository`, the membership lookup and
the auth gate have no test of their own. The domain logic underneath them has
77, and the database beneath that has 62; the layer that joins the two has
none. Milestone 8 should close it with a test user the suite can authenticate
as -- never with a service-role key, which bypasses the RLS the tests exist to
check.

The download mechanism, for the same reason. `reportToCsv` and `reportToPdf`
are tested against the source data (31 tests), but `triggerDownload` -- the
blob, the object URL and the programmatic click on a hidden anchor -- cannot
run in Node. Verified by a person on 2026-11-18 in Chrome: all five reports,
category and product filters, both formats; filenames correct, CSV context
block intact and free of encoding damage, PDF paginated with correct page
counts, both buttons disabled on an empty result. Same caveat as above -- it
worked once, which is not the same as it works.

## Why the remaining tests are `it.todo` rather than passing

This matters more than the 63 that pass, and §15 assesses exactly this kind of
honesty ("Do not claim success without evidence").

**Viewer write rejection.** The client-side check is tested and passes, but that
only proves the buttons are disabled. The brief's requirement is that the
*database* rejects the operation. Demo mode has no database, so the requirement
is half-met and labelled half-met.

**Cross-tenant isolation.** The demo repository filters by `organization_id`
using the same code under test. A test like that cannot fail for the right
reason — it would be the filter checking itself. Real isolation is a Row Level
Security property and needs a second authenticated client in milestone 5.

**Concurrency.** This is the one to understand. Two officers issuing 20 from a
batch of 30 at the same instant:

```
read 30  →  read 30  →  both see "enough"  →  both write 10
```

JavaScript offers no row lock, so `DemoInventoryRepository` genuinely cannot
prevent this across two browser tabs. A passing "concurrency test" written
against it would manufacture confidence in precisely the area the brief calls
the *critical implementation rule*. The fix is a PostgreSQL function using
`SELECT ... FOR UPDATE`, and the test needs two real sessions.

A green suite that hides a known gap is worse than a suite with three honest
`todo`s.

## Invariant checked throughout

For every batch, the signed movement deltas sum to `quantity_on_hand`. Asserted
on the seed data and re-asserted after reversals. If it ever breaks, either a
quantity was written without a movement, or history was tampered with.
