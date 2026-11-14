# ClinicStock — Intern Learning Roadmap

Maps the brief (`ClinicStock_Intern_Development_Brief.pdf`) onto milestones we work
through one at a time. Rule from §14 of the brief: finish a milestone, explain it,
stop for review, then move on.

## Milestone 0 — Discovery (brief §17, §13)
Not a coding task. Owned by you, not by me.
- [ ] Ask the medical mentor how stock is tracked today (paper / spreadsheet / software).
- [ ] Write out ONE end-to-end receipt and ONE end-to-end issue, naming who does each step.
- [ ] Note where errors happen today (miscounts, expiry surprises, missing records).
- [ ] Confirm the product categories and units the first clinic actually uses.
- [ ] Confirm in writing: synthetic data only, no patient data.

Why first: §15 weights "product understanding" at 15% and every design choice below
(units, categories, who may adjust stock) depends on these answers.

## Milestone 1 — Architecture, no code (Prompt 1)
Deliverable: `docs/ARCHITECTURE.md` — folder structure, data model, navigation,
build sequence, risks.
Why no code: decisions about the data model are expensive to undo once screens exist.

## Milestone 2 — Project setup + shell
`create-next-app`, Tailwind, routing, layout, navigation, DEMO banner.
Deliverable: app runs locally, every route reachable, nothing wired to data.

## Milestone 3 — Domain logic + demo repository (Prompt 3, brief §7, §9)
The heart of the project. Pure TypeScript: stock totals, FEFO, expiry bands,
low stock, receipt/issue/adjustment validation. Backed by `DemoInventoryRepository`
(localStorage) behind the `InventoryRepository` interface from §9.
Deliverable: unit tests covering every row of the §11 test table that does not
need a database.

## Milestone 4 — Screens on demo data (Prompt 2, brief §4)
Dashboard, inventory, product details, receive, issue, adjust, reports, settings.
Loading / empty / success / error states explicit.

## Milestone 5 — Database + security (Prompt 4, brief §6, §8)
Supabase migrations, UUID keys, constraints, indexes, Row Level Security,
transactional SQL functions that lock the batch row.
Deliverable: migrations + cross-tenant security tests.

## Milestone 6 — Connect app to database (Prompt 5)
`SupabaseInventoryRepository` swapped in behind the same interface. UI unchanged.
Auth, org membership, role-aware UI.

## Milestone 7 — Reports (Prompt 6)
CSV via PapaParse, PDF via jsPDF, filters, totals that match source records.

## Milestone 8 — QA, security review, deployment (Prompts 7, 8)
Full §11 test pass, concurrency test, static export, Cloudflare Pages,
backup/restore procedure, honest list of unresolved risks.

## Non-negotiables carried through every milestone
1. The browser never writes `quantity_on_hand` directly (§7).
2. Movement history is append-only; corrections are reversals, never edits (§3).
3. Permissions live in the database, not in hidden buttons (§3).
4. Synthetic data only (§8).
5. A deployed demo is not a production clinical system (§8).
