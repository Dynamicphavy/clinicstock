# ClinicStock — Architecture (Milestone 1 deliverable)

Status: proposed, awaiting intern review. No code written yet.

## 1. The one workflow that must be trustworthy

Brief §17: "register an item, receive a batch, issue stock, see an expiry warning
and trace who performed the movement."

Everything else (reports, charts, settings) is decoration on top of that spine.
When time runs out, the spine ships complete and the decoration gets cut.

## 2. Core domain concepts

**Product** — a master record. "Paracetamol 500mg", SKU MED-001. Has NO quantity.
**Batch** — a physical consignment of one product, with its own expiry date and
its own `quantity_on_hand`. This is the only place a number lives.
**Movement** — an immutable log line: this batch changed by +100 at this time by
this user for this reason.

Why products hold no quantity: two deliveries of gloves can expire in March and
in December. If the product held a single number, you could not answer "how much
expires this month?" — the central question the clinic has. So:

    product_total = SUM(batch.quantity_on_hand)   -- derived, never stored

A stored total is a second source of truth that will drift from the batches.
Deriving it cannot drift.

Why movements are append-only: the clinic's real question when a count is wrong is
"who did what?". An UPDATE destroys that answer. A correction is therefore a new
compensating movement (a reversal), not an edit. Balance + full history, always.

## 3. Layering (the most important decision here)

    UI components (React)
        |  calls, knows nothing about storage
    InventoryRepository (interface, brief §9)
        |
        +-- DemoInventoryRepository     -> localStorage   (milestones 3-4)
        +-- SupabaseInventoryRepository -> PostgreSQL      (milestone 6)

    domain/  <- pure functions: expiry bands, FEFO, low stock, validation
                No React, no network, no dates read from the system clock.

Why an interface in the middle: it lets us build and test every screen and every
rule before a database exists, then swap the implementation without touching the
UI. It also makes the domain testable — pure functions with no I/O are the only
code you can test quickly and exhaustively.

Why `today` is passed in rather than read inside the functions: a function that
calls `new Date()` internally cannot be tested ("expiry tomorrow" would need you
to wait a day). Pass the clinic's local today as an argument.

## 4. Where each rule is enforced

| Rule | Browser | Database |
|---|---|---|
| Quantity > 0 | yes (fast feedback) | yes (authority) |
| Sufficient stock | yes | yes |
| Expired batch cannot be issued | yes | yes |
| Adjustment needs a reason | yes | yes |
| Role may perform this action | yes (hide UI) | yes (authority) |
| Tenant isolation | no | yes, RLS only |

Both columns, deliberately. The browser copy is for usability; the database copy
is the real rule. Anyone can open devtools and call the API directly, so a check
that exists only in React is not a check at all. This is brief §3's
"not only by hiding buttons".

## 5. Concurrency — why stock changes must be SQL functions

Two officers issue 20 units from a batch holding 30, at the same moment:

    read 30 ... read 30 ... both see "enough" ... both write 10

30 units became 10 on paper and -10 in reality. This is a lost update, and no
amount of frontend validation prevents it. The fix is a database function that
does, inside one transaction:

    SELECT ... FROM batches WHERE id = ... FOR UPDATE   -- locks the row
    verify org membership and role
    verify quantity available and batch not expired
    UPDATE the balance
    INSERT the movement
    COMMIT

`FOR UPDATE` makes the second request wait for the first to commit, so it re-reads
the real remaining 10 and is correctly rejected. Balance and history commit
together or not at all, so they can never disagree.

> **Milestone 8 correction.** The "both write 10" lost update above assumes
> each request writes an absolute value. The implemented `issue_stock` writes
> relatively and the schema forbids negative balances, so without the lock the
> data stays correct and the second request fails at write time with a raw
> constraint error. The lock's real contribution is a correct business refusal
> (`INSUFFICIENT_STOCK`) before any write. Both are proven against a real server
> in `tests/concurrency/issue-race.test.ts`; see `DATABASE.md`.

Functions needed: `receive_stock`, `issue_stock`, `adjust_stock`, `reverse_movement`.

## 6. Proposed folder structure

    clinicstock/
      src/
        app/                      # Next.js App Router, one folder per screen
          login/  dashboard/  inventory/  inventory/[id]/
          receive/  issue/  adjust/  reports/  settings/
          layout.tsx
        components/
          ui/                     # Button, Input, Table, Badge, Modal
          inventory/              # ProductTable, BatchList, ExpiryBadge
          layout/                 # Sidebar, TopBar, DemoBanner
        domain/                   # PURE LOGIC, no imports from react or supabase
          types.ts                # Product, Batch, Movement, Role
          expiry.ts               # expiry bands, days to expiry
          stock.ts                # totals, low stock, FEFO selection
          validation.ts           # Zod schemas + rule checks
        repositories/
          InventoryRepository.ts  # the interface
          demo/                   # localStorage implementation + seed data
          supabase/               # cloud implementation
        lib/                      # formatting, csv, pdf helpers
      supabase/migrations/        # numbered .sql files
      tests/

Why `domain/` is a sibling of `app/` and forbidden from importing React: the day
you need the same FEFO rule inside a SQL function or a test harness, it has no
UI dependencies to untangle.

## 7. Build sequence (dependency order, not feature order)

1. types + expiry + stock + validation, with tests  <- no UI at all
2. DemoInventoryRepository + synthetic seed data (brief §9 dataset)
3. layout, navigation, DEMO banner
4. inventory table -> product details -> receive -> issue -> adjust
5. dashboard (it only aggregates things that already work)
6. reports and exports
7. Supabase schema, RLS, SQL functions, security tests
8. SupabaseInventoryRepository, auth, roles
9. QA pass, deployment, backup procedure

Dashboard comes late on purpose. It is the most satisfying screen to build and
the least useful to build early — it displays numbers that other screens produce.

## 8. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Static export has no server runtime | server actions / API routes unavailable; tempting to leak a key | all privileged work in SQL functions; never a service-role key in the browser. **Hit in milestone 4:** `/product/[id]` cannot work, because static export needs every id at build time via `generateStaticParams()` and our products live in per-clinic storage. Resolved by changing the URL to `/product?id=X`, read in the browser -- not by adding a server or leaking a key. `useSearchParams` also needs a `<Suspense>` boundary during prerender. |
| RLS written late | retrofitting policies across 8 tables is error-prone | write policies in the same migration as each table |
| Concurrency untested | the one bug that loses the clinic's trust | explicit two-session concurrent-issue test in milestone 8 |
| Supabase Free: no automatic backups, project pausing | real clinic data could be lost | synthetic data only until backup/restore is tested and documented |
| Scope creep (suppliers, barcodes, multi-branch) | §2 non-goals | suppliers table exists but nullable and unused in MVP UI |
| Timezone drift on expiry | a batch "expires" a day early or late | one clinic-local `today`, passed explicitly, computed once per render |
| Units undefined with clinic | boxes vs pieces makes totals meaningless | Milestone 0 question, blocking |

## 9. Open questions for the clinic (before Milestone 5)

1. Must batch numbers be unique per product, or can a supplier reuse one?
2. Which product types legally require an expiry date?
3. Who is allowed to correct a wrong count — officer, or admin only?
4. For undated stock, is oldest-receipt-first the agreed fallback issue order?
5. What reason codes does the clinic actually use for issues and adjustments?
