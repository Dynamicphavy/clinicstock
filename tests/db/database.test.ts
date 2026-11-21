/**
 * Database-level security and transaction tests (brief sections 8 and 11).
 *
 * These run the REAL migrations against a REAL PostgreSQL engine. What they
 * verify is not that our TypeScript is careful, but that the database refuses
 * things on its own -- which is the only check that counts, because a client
 * can always be bypassed.
 *
 * Every test starts from the freshly migrated state. Shared mutable state
 * between security tests is how you end up with a suite that passes in one
 * order and leaks in another.
 *
 * Milestone 5 got that by building a new PostgreSQL per test. Milestone 8
 * found that 62 WASM PostgreSQL instances exhaust a 3.7 GB machine -- runs of
 * the same commit disagreed, and the worker was OOM-killed. So there is now
 * ONE database per file, and resetDb() restores it before each test.
 *
 * That trade is only acceptable with evidence, so the first describe block
 * below proves the reset is complete (fingerprint equals a fresh database) and
 * the suite is run with shuffled order (`npm run test:shuffle`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  ADMIN_A, ADMIN_B, BATCH_A_EXPIRED, BATCH_A_GOOD,
  OFFICER_A, ORG_A, ORG_B, PRODUCT_A, VIEWER_A,
  asUser, expectFailure, fingerprint, freshDb, resetDb,
} from "./harness";

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
}, 120_000);

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  // Guarded: if freshDb() threw, `db` is undefined and an unguarded close()
  // replaces the real error with "cannot read properties of undefined",
  // which is how one broken migration looked like ten broken tests.
  await db?.close();
});

describe("test isolation (milestone 8)", () => {
  it("a reset returns the database to exactly the freshly migrated state", async () => {
    // Dirty every kind of state resetDb() claims to clean, including the
    // ones a row delete would miss.
    await asUser(db, ADMIN_A, () =>
      db.query("select issue_stock($1, 5, 'Ward round', null)", [BATCH_A_GOOD]),
    );
    await db.exec(`insert into categories (organization_id, name)
                   values ('${ORG_A}', 'Leftover from a previous test')`);
    await db.exec("select set_config('request.jwt.claims', '{\"sub\":\"" + VIEWER_A + "\"}', false);");
    await db.exec("set role anon;");

    await resetDb(db);

    const reference = await freshDb();
    try {
      expect(await fingerprint(db)).toEqual(await fingerprint(reference));
    } finally {
      await reference.close();
    }
  }, 120_000);

  it("the fingerprint is sensitive enough to fail on a leftover", async () => {
    // Control case. Without it, the test above could pass because
    // fingerprint() hashes nothing -- a check that cannot fail proves nothing.
    const before = await fingerprint(db);
    await db.exec(`insert into categories (organization_id, name)
                   values ('${ORG_A}', 'One extra row')`);
    const after = await fingerprint(db);
    expect(after["rows:public.categories"]).not.toBe(before["rows:public.categories"]);
  });

  it("cleanup needs TRUNCATE because our own trigger refuses DELETE", async () => {
    const e = await expectFailure(() => db.query("delete from stock_movements"));
    expect(e.code).toBe("P0001");
    expect(e.detail).toBe("APPEND_ONLY_VIOLATION");
  });

  it("no client role holds TRUNCATE, which would bypass append-only", async () => {
    // Row-level triggers do not fire on TRUNCATE. The append-only rule is
    // therefore only as strong as the absence of this privilege.
    const r = await db.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
        where table_schema = 'public'
          and privilege_type = 'TRUNCATE'
          and grantee in ('anon', 'authenticated')`,
    );
    expect(r.rows).toEqual([]);
  });
});

/** Balance of one batch, read with RLS bypassed, for assertions. */
async function balance(batchId: string): Promise<number> {
  const r = await db.query<{ quantity_on_hand: number }>(
    "select quantity_on_hand from batches where id = $1",
    [batchId],
  );
  return r.rows[0]?.quantity_on_hand ?? -1;
}

/** The audit invariant: signed deltas must equal the batch balance. */
async function deltaSum(batchId: string): Promise<number> {
  const r = await db.query<{ sum: string | null }>(
    "select sum(quantity_delta)::text as sum from stock_movements where batch_id = $1",
    [batchId],
  );
  return Number(r.rows[0]?.sum ?? 0);
}

// ===========================================================================
describe("schema constraints", () => {
// ===========================================================================

  it("rejects a duplicate SKU within one clinic", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `insert into products (organization_id, name, sku, unit)
           values ($1, 'Another paracetamol', 'MED-001', 'tablet')`,
          [ORG_A],
        ),
      );
      // 23505 = unique_violation. Asserting the CODE, not just "it failed":
      // a typo'd column name would also fail, and would prove nothing.
      expect(err.code).toBe("23505");
    });
  });

  it("rejects a duplicate SKU differing only by case", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `insert into products (organization_id, name, sku, unit)
           values ($1, 'Sneaky', 'med-001', 'tablet')`,
          [ORG_A],
        ),
      );
      expect(err.code).toBe("23505");
    });
  });

  it("ALLOWS the same SKU in a different clinic", async () => {
    // Clinic A and Clinic B both run MED-001 in the seed data. That is their
    // own numbering, not a collision -- SKU is unique per organisation.
    const r = await db.query<{ n: string }>(
      "select count(*)::text as n from products where upper(sku) = 'MED-001'",
    );
    expect(Number(r.rows[0].n)).toBe(2);
  });

  it("rejects a duplicate batch number within one product", async () => {
    const err = await expectFailure(() =>
      db.query(
        `insert into batches (organization_id, product_id, batch_number,
                              quantity_on_hand, received_at)
         values ($1, $2, 'para-a', 10, current_date)`,
        [ORG_A, PRODUCT_A],
      ),
    );
    expect(err.code).toBe("23505");
  });

  it("refuses a negative balance even for a superuser", async () => {
    // The last line of defence against overselling. Nothing in the database
    // can record stock the clinic does not have.
    const err = await expectFailure(() =>
      db.query(
        `insert into batches (organization_id, product_id, batch_number,
                              quantity_on_hand, received_at)
         values ($1, $2, 'NEGATIVE', -1, current_date)`,
        [ORG_A, PRODUCT_A],
      ),
    );
    expect(err.code).toBe("23514"); // check_violation
  });

  it("refuses a zero-quantity movement", async () => {
    const err = await expectFailure(() =>
      db.query(
        `insert into stock_movements (organization_id, batch_id, movement_type,
                                      quantity_delta, reason, performed_by)
         values ($1, $2, 'adjustment', 0, 'Recount', $3)`,
        [ORG_A, BATCH_A_GOOD, ADMIN_A],
      ),
    );
    expect(err.code).toBe("23514");
  });

  it("refuses an expiry date earlier than the receipt date", async () => {
    const err = await expectFailure(() =>
      db.query(
        `insert into batches (organization_id, product_id, batch_number,
                              quantity_on_hand, received_at, expiry_date)
         values ($1, $2, 'BACKWARDS', 5, current_date, current_date - 5)`,
        [ORG_A, PRODUCT_A],
      ),
    );
    expect(err.code).toBe("23514");
  });

  it("refuses an issue or adjustment with no reason", async () => {
    const err = await expectFailure(() =>
      db.query(
        `insert into stock_movements (organization_id, batch_id, movement_type,
                                      quantity_delta, performed_by)
         values ($1, $2, 'issue', -1, $3)`,
        [ORG_A, BATCH_A_GOOD, ADMIN_A],
      ),
    );
    expect(err.code).toBe("23514");
  });
});

// ===========================================================================
describe("tenant isolation (RLS)", () => {
// ===========================================================================

  it("Clinic A sees only Clinic A's products", async () => {
    await asUser(db, OFFICER_A, async () => {
      const r = await db.query<{ organization_id: string }>("select organization_id from products");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].organization_id).toBe(ORG_A);
    });
  });

  it("Clinic B queries Clinic A and gets NOTHING", async () => {
    // Brief section 11: "Clinic A queries Clinic B -> no data is returned;
    // access is denied." Note the shape of the denial: an empty result, not an
    // error. Clinic B learns nothing at all -- not even that the row exists.
    await asUser(db, ADMIN_B, async () => {
      const batches = await db.query("select * from batches where id = $1", [BATCH_A_GOOD]);
      expect(batches.rows).toHaveLength(0);

      const products = await db.query("select * from products where organization_id = $1", [ORG_A]);
      expect(products.rows).toHaveLength(0);

      const movements = await db.query("select * from stock_movements where organization_id = $1", [ORG_A]);
      expect(movements.rows).toHaveLength(0);
    });
  });

  it("an admin cannot create a product inside another clinic", async () => {
    await asUser(db, ADMIN_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `insert into products (organization_id, name, sku, unit)
           values ($1, 'Trojan', 'TROJAN-1', 'box')`,
          [ORG_B],
        ),
      );
      // 42501 = insufficient_privilege: "new row violates row-level security".
      expect(err.code).toBe("42501");
    });
  });

  it("an unauthenticated session sees nothing", async () => {
    await asUser(db, ADMIN_A, async () => {
      // Clear the claim: this is a request arriving with no valid token.
      await db.exec("select set_config('request.jwt.claims', '', false);");
      const r = await db.query("select * from products");
      expect(r.rows).toHaveLength(0);
    });
  });
});

// ===========================================================================
describe("stock tables are not directly writable", () => {
// ===========================================================================
//
// Brief section 7: "Never let the frontend directly update quantity_on_hand."
// There is no UPDATE policy and no UPDATE grant on batches, for anyone. The
// rule is not enforced by a check -- it is structurally impossible.

  it("an admin cannot UPDATE a batch balance directly", async () => {
    await asUser(db, ADMIN_A, async () => {
      const err = await expectFailure(() =>
        db.query("update batches set quantity_on_hand = 999 where id = $1", [BATCH_A_GOOD]),
      );
      expect(err.code).toBe("42501");
    });
    expect(await balance(BATCH_A_GOOD)).toBe(30);
  });

  it("an admin cannot INSERT a movement directly", async () => {
    await asUser(db, ADMIN_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `insert into stock_movements (organization_id, batch_id, movement_type,
                                        quantity_delta, reason, performed_by)
           values ($1, $2, 'issue', -5, 'Invented', $3)`,
          [ORG_A, BATCH_A_GOOD, ADMIN_A],
        ),
      );
      expect(err.code).toBe("42501");
    });
  });

  it("an admin cannot DELETE a batch", async () => {
    await asUser(db, ADMIN_A, async () => {
      const err = await expectFailure(() =>
        db.query("delete from batches where id = $1", [BATCH_A_GOOD]),
      );
      expect(err.code).toBe("42501");
    });
  });
});

// ===========================================================================
describe("movement history is append-only", () => {
// ===========================================================================

  it("cannot be UPDATEd, even by a superuser", async () => {
    // Stronger than the brief's "append-only for normal users". The audit trail
    // is the staff's protection against being blamed for a discrepancy, and a
    // trail an operator can quietly edit protects nobody.
    const err = await expectFailure(() =>
      db.query("update stock_movements set quantity_delta = 1 where batch_id = $1", [BATCH_A_GOOD]),
    );
    expect(err.detail).toBe("APPEND_ONLY_VIOLATION");
  });

  it("cannot be DELETEd, even by a superuser", async () => {
    const err = await expectFailure(() =>
      db.query("delete from stock_movements where batch_id = $1", [BATCH_A_GOOD]),
    );
    expect(err.detail).toBe("APPEND_ONLY_VIOLATION");
  });
});

// ===========================================================================
describe("receive_stock", () => {
// ===========================================================================

  it("creates a batch, records a receipt, and keeps the invariant", async () => {
    await asUser(db, OFFICER_A, async () => {
      const r = await db.query<{ id: string; quantity_on_hand: number }>(
        `select * from receive_stock($1, 'PARA-NEW', 100, current_date, current_date + 365)`,
        [PRODUCT_A],
      );
      expect(r.rows[0].quantity_on_hand).toBe(100);
      expect(await deltaSum(r.rows[0].id)).toBe(100);
    });
  });

  it("tops up an existing batch rather than splitting the consignment", async () => {
    await asUser(db, OFFICER_A, async () => {
      await db.query(
        `select receive_stock($1, 'PARA-A', 20, current_date, (
            select expiry_date from batches where id = $2
         ))`,
        [PRODUCT_A, BATCH_A_GOOD],
      );
    });
    expect(await balance(BATCH_A_GOOD)).toBe(50);
    expect(await deltaSum(BATCH_A_GOOD)).toBe(50);
  });

  it("refuses to reuse a batch number with a different expiry date", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `select receive_stock($1, 'PARA-A', 20, current_date, current_date + 900)`,
          [PRODUCT_A],
        ),
      );
      expect(err.detail).toBe("DUPLICATE_BATCH_NUMBER");
    });
  });

  it("refuses a zero or negative quantity", async () => {
    await asUser(db, OFFICER_A, async () => {
      for (const q of [0, -5]) {
        const err = await expectFailure(() =>
          db.query(`select receive_stock($1, 'Q-TEST', $2, current_date, null)`, [PRODUCT_A, q]),
        );
        expect(err.detail).toBe("QUANTITY_NOT_POSITIVE");
      }
    });
  });

  it("refuses an expiry date before the receipt date", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `select receive_stock($1, 'BACKWARDS', 10, current_date, current_date - 1)`,
          [PRODUCT_A],
        ),
      );
      expect(err.detail).toBe("EXPIRY_BEFORE_RECEIPT");
    });
  });

  it("takes the organisation from the product, not from the caller", async () => {
    // Clinic B's admin naming Clinic A's product. The function resolves the org
    // from the product row and finds Clinic B is not a member.
    //
    // Reported as PRODUCT_NOT_FOUND, not PERMISSION_DENIED (changed in 0005):
    // "permission denied" would confirm the product exists. Absent and
    // not-yours must look identical from outside.
    await asUser(db, ADMIN_B, async () => {
      const err = await expectFailure(() =>
        db.query(`select receive_stock($1, 'CROSS', 10, current_date, null)`, [PRODUCT_A]),
      );
      expect(err.detail).toBe("PRODUCT_NOT_FOUND");
    });
    const r = await db.query("select * from batches where batch_number = 'CROSS'");
    expect(r.rows).toHaveLength(0);
  });
});

// ===========================================================================
describe("issue_stock", () => {
// ===========================================================================

  it("decrements the batch and records an issue", async () => {
    await asUser(db, OFFICER_A, async () => {
      const r = await db.query<{ quantity_on_hand: number }>(
        "select * from issue_stock($1, 20, 'Ward usage')",
        [BATCH_A_GOOD],
      );
      expect(r.rows[0].quantity_on_hand).toBe(10);
    });
    expect(await deltaSum(BATCH_A_GOOD)).toBe(10);

    const m = await db.query<{ movement_type: string; quantity_delta: number; performed_by: string }>(
      "select * from stock_movements where batch_id = $1 and movement_type = 'issue'",
      [BATCH_A_GOOD],
    );
    expect(m.rows[0].quantity_delta).toBe(-20);
    expect(m.rows[0].performed_by).toBe(OFFICER_A);
  });

  it("rejects issuing more than the batch holds, and changes nothing", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 31, 'Ward usage')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("INSUFFICIENT_STOCK");
      // The message must tell staff what IS available.
      expect(err.message).toContain("30");
    });
    expect(await balance(BATCH_A_GOOD)).toBe(30);
    // A rejected operation leaves no trace in history either: the whole
    // function body is one transaction, so the rollback takes the movement too.
    expect(await deltaSum(BATCH_A_GOOD)).toBe(30);
  });

  it("rejects issuing from an expired batch", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [BATCH_A_EXPIRED]),
      );
      expect(err.detail).toBe("BATCH_EXPIRED");
    });
    expect(await balance(BATCH_A_EXPIRED)).toBe(40);
  });

  it("rejects an issue with no reason code", async () => {
    await asUser(db, OFFICER_A, async () => {
      for (const reason of ["", "  ", "ab"]) {
        const err = await expectFailure(() =>
          db.query("select issue_stock($1, 1, $2)", [BATCH_A_GOOD, reason]),
        );
        expect(err.detail).toBe("REASON_REQUIRED");
      }
    });
  });

  it("rejects an unknown batch", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [
          "00000000-0000-4000-8000-000000000000",
        ]),
      );
      expect(err.detail).toBe("BATCH_NOT_FOUND");
    });
  });

  it("uses the SERVER's date for expiry, not a client-supplied one", async () => {
    // There is no p_today parameter, by design. If the client supplied today's
    // date it could claim to be last year and issue expired stock -- the same
    // "never trust a value the client controls" rule behind auth.uid().
    const r = await db.query<{ n: string }>(
      `select count(*)::text as n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'issue_stock'
         and pg_get_function_arguments(p.oid) ilike '%today%'`,
    );
    expect(Number(r.rows[0].n)).toBe(0);
  });

  it("allows issuing stock that expires TODAY", async () => {
    // Expired means strictly "before today" (brief section 7). Stock expiring
    // today is still usable today, and blocking it would refuse a legitimate
    // issue on the last valid day.
    await db.query(
      `insert into batches (organization_id, product_id, batch_number,
                            quantity_on_hand, received_at, expiry_date)
       values ($1, $2, 'EXPIRES-TODAY', 10, current_date - 10,
               (now() at time zone 'Africa/Lagos')::date)`,
      [ORG_A, PRODUCT_A],
    );
    const id = (
      await db.query<{ id: string }>("select id from batches where batch_number = 'EXPIRES-TODAY'")
    ).rows[0].id;

    await asUser(db, OFFICER_A, async () => {
      const r = await db.query<{ quantity_on_hand: number }>(
        "select * from issue_stock($1, 4, 'Ward usage')",
        [id],
      );
      expect(r.rows[0].quantity_on_hand).toBe(6);
    });
  });
});

// ===========================================================================
describe("adjust_stock", () => {
// ===========================================================================

  it("applies a signed delta with a reason and an actor", async () => {
    await asUser(db, OFFICER_A, async () => {
      const r = await db.query<{ quantity_on_hand: number }>(
        "select * from adjust_stock($1, -5, 'Damaged in storage')",
        [BATCH_A_GOOD],
      );
      expect(r.rows[0].quantity_on_hand).toBe(25);
    });
    const m = await db.query<{ reason: string; performed_by: string }>(
      "select * from stock_movements where batch_id = $1 and movement_type = 'adjustment'",
      [BATCH_A_GOOD],
    );
    expect(m.rows[0].reason).toBe("Damaged in storage");
    expect(m.rows[0].performed_by).toBe(OFFICER_A);
  });

  it("rejects an adjustment with no reason", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select adjust_stock($1, -5, '')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("REASON_REQUIRED");
    });
  });

  it("rejects a zero adjustment", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select adjust_stock($1, 0, 'Recount')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("DELTA_ZERO");
    });
  });

  it("rejects an adjustment that would go below zero", async () => {
    await asUser(db, OFFICER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select adjust_stock($1, -31, 'Recount')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("INSUFFICIENT_STOCK");
    });
    expect(await balance(BATCH_A_GOOD)).toBe(30);
  });

  it("ALLOWS writing off an expired batch", async () => {
    // Deliberately no expiry check in adjust_stock. Blocking this would trap
    // expired units on the books forever: unissuable because expired, and
    // unremovable because we refused the only mechanism that removes them.
    await asUser(db, OFFICER_A, async () => {
      const r = await db.query<{ quantity_on_hand: number }>(
        "select * from adjust_stock($1, -40, 'Expired stock written off')",
        [BATCH_A_EXPIRED],
      );
      expect(r.rows[0].quantity_on_hand).toBe(0);
    });
    expect(await deltaSum(BATCH_A_EXPIRED)).toBe(0);
  });
});

// ===========================================================================
describe("reverse_movement", () => {
// ===========================================================================

  it("compensates with a new row and leaves the original untouched", async () => {
    let issueId = "";
    await asUser(db, OFFICER_A, async () => {
      await db.query("select issue_stock($1, 10, 'Ward usage')", [BATCH_A_GOOD]);
    });
    issueId = (
      await db.query<{ id: string }>(
        "select id from stock_movements where batch_id = $1 and movement_type = 'issue'",
        [BATCH_A_GOOD],
      )
    ).rows[0].id;

    await asUser(db, ADMIN_A, async () => {
      const r = await db.query<{ quantity_on_hand: number }>(
        "select * from reverse_movement($1, 'Issued against the wrong batch')",
        [issueId],
      );
      expect(r.rows[0].quantity_on_hand).toBe(30);
    });

    // The original issue is still there, unchanged. History shows the mistake
    // AND the correction -- which is what stops a typo looking like theft.
    const original = await db.query<{ quantity_delta: number }>(
      "select * from stock_movements where id = $1",
      [issueId],
    );
    expect(original.rows[0].quantity_delta).toBe(-10);

    const reversal = await db.query<{ quantity_delta: number; reverses_movement_id: string }>(
      "select * from stock_movements where movement_type = 'reversal'",
    );
    expect(reversal.rows[0].quantity_delta).toBe(10);
    expect(reversal.rows[0].reverses_movement_id).toBe(issueId);

    expect(await deltaSum(BATCH_A_GOOD)).toBe(30);
  });

  it("refuses to reverse the same movement twice", async () => {
    // Reversing an ISSUE, not the opening receipt.
    //
    // My first version of this test reversed the receipt twice and expected
    // 23505 from the unique index. It got INSUFFICIENT_STOCK instead -- and the
    // function was right: undoing a +30 receipt twice would drive the balance
    // to -30, so the negative-balance guard fires BEFORE the index is reached.
    // Reversing an issue (+10 each time) keeps the balance positive, so the
    // index is what stops the second attempt. Check order matters, and a test
    // that asserts a specific code is what surfaces it.
    await asUser(db, OFFICER_A, async () => {
      await db.query("select issue_stock($1, 10, 'Ward usage')", [BATCH_A_GOOD]);
    });
    const issueId = (
      await db.query<{ id: string }>(
        "select id from stock_movements where batch_id = $1 and movement_type = 'issue'",
        [BATCH_A_GOOD],
      )
    ).rows[0].id;

    await asUser(db, ADMIN_A, async () => {
      await db.query("select reverse_movement($1, 'First reversal')", [issueId]);
      const err = await expectFailure(() =>
        db.query("select reverse_movement($1, 'Second reversal')", [issueId]),
      );
      // Caught by the unique partial index, not by application logic.
      expect(err.code).toBe("23505");
    });
    expect(await balance(BATCH_A_GOOD)).toBe(30);
  });

  it("refuses a reversal with no reason", async () => {
    const receiptId = (
      await db.query<{ id: string }>("select id from stock_movements where batch_id = $1", [BATCH_A_GOOD])
    ).rows[0].id;
    await asUser(db, ADMIN_A, async () => {
      const err = await expectFailure(() =>
        db.query("select reverse_movement($1, '')", [receiptId]),
      );
      expect(err.detail).toBe("REASON_REQUIRED");
    });
  });
});

// ===========================================================================
describe("role enforcement, at the database", () => {
// ===========================================================================

  /**
   * This is the test that was `it.todo` for two milestones.
   *
   * In the demo repository a viewer was stopped by a TypeScript check -- which
   * anyone could bypass by constructing the repository with role: "admin",
   * because the role was client-supplied data. Here the role is a row in
   * organization_members that the user cannot write, read by the function
   * itself. There is nothing to tamper with.
   */
  it("a viewer cannot receive, issue or adjust stock", async () => {
    await asUser(db, VIEWER_A, async () => {
      const calls: [string, unknown[]][] = [
        ["select receive_stock($1, 'VIEWER-TRY', 10, current_date, null)", [PRODUCT_A]],
        ["select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]],
        ["select adjust_stock($1, -1, 'Recount')", [BATCH_A_GOOD]],
      ];
      for (const [sql, params] of calls) {
        const err = await expectFailure(() => db.query(sql, params));
        expect(err.detail).toBe("PERMISSION_DENIED");
      }
    });
    expect(await balance(BATCH_A_GOOD)).toBe(30);
  });

  it("a viewer CAN still read inventory", async () => {
    await asUser(db, VIEWER_A, async () => {
      const r = await db.query("select * from products");
      expect(r.rows).toHaveLength(1);
    });
  });

  it("a user from another clinic is told the batch does not exist", async () => {
    // This assertion is REVERSED from milestone 5, and the old comment was
    // wrong. It said PERMISSION_DENIED meant the caller "learns nothing about
    // whether it exists" -- but permission-denied confirms it exists. The
    // honest answer is the one a non-existent id would give.
    await asUser(db, ADMIN_B, async () => {
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("BATCH_NOT_FOUND");
    });
  });

  it("gives an outsider the SAME answer for a real and a fake batch id", async () => {
    // The actual property we want, stated directly: the two responses must be
    // indistinguishable. Asserting each code separately would not catch a
    // future change that made them differ again.
    await asUser(db, ADMIN_B, async () => {
      const real = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]),
      );
      const fake = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [
          "00000000-0000-4000-8000-00000000beef".replace("beef", "0000"),
        ]),
      );
      expect(real.detail).toBe(fake.detail);
      expect(real.message).toBe(fake.message);
    });
  });

  it("an unauthenticated caller is refused", async () => {
    await asUser(db, ADMIN_A, async () => {
      await db.exec("select set_config('request.jwt.claims', '', false);");
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("AUTH_REQUIRED");
    });
  });

  it("an admin cannot promote themselves", async () => {
    // Brief section 3: "A user must not be able to grant themselves
    // administrator privileges." Tested from the admin side because only an
    // admin gets past the policy at all -- the trigger is what stops them.
    await asUser(db, ADMIN_A, async () => {
      const err = await expectFailure(() =>
        db.query(
          `update organization_members set role = 'viewer'
           where user_id = $1 and organization_id = $2`,
          [ADMIN_A, ORG_A],
        ),
      );
      expect(err.detail).toBe("PERMISSION_DENIED");
    });
  });

  it("an officer cannot change anyone's role", async () => {
    await asUser(db, OFFICER_A, async () => {
      const r = await db.query(
        `update organization_members set role = 'admin'
         where user_id = $1 and organization_id = $2`,
        [OFFICER_A, ORG_A],
      );
      // No matching UPDATE policy, so the row is simply invisible to the
      // statement: zero rows affected rather than an error.
      expect(r.affectedRows).toBe(0);
    });
    const after = await db.query<{ role: string }>(
      "select role from organization_members where user_id = $1",
      [OFFICER_A],
    );
    expect(after.rows[0].role).toBe("inventory_officer");
  });
});

// ===========================================================================
describe("concurrency", () => {
// ===========================================================================

  it("rejects the second of two sequential issues that exceed the balance", async () => {
    // NOT a concurrency test. It proves the balance is re-read between calls,
    // which is necessary but not sufficient -- the race happens when the two
    // calls overlap, and this test never overlaps them.
    await asUser(db, OFFICER_A, async () => {
      await db.query("select issue_stock($1, 20, 'Ward usage')", [BATCH_A_GOOD]);
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 20, 'Ward usage')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("INSUFFICIENT_STOCK");
    });
    expect(await balance(BATCH_A_GOOD)).toBe(10);
  });

  it("locks the batch row before validating", async () => {
    // Structural evidence, not behavioural proof: the lock clause is present in
    // the deployed function body. Worth asserting because deleting FOR UPDATE
    // breaks nothing visible -- every other test here would still pass.
    const r = await db.query<{ src: string }>(
      "select prosrc as src from pg_proc where proname = 'issue_stock'",
    );
    expect(r.rows[0].src.toLowerCase()).toContain("for update");
  });

  /**
   * The real thing, still deferred -- and the reason is the test harness, not
   * the code.
   *
   * PGlite is a single connection: one backend process, no second session to
   * contend with. Two transactions cannot fight over a row lock here, so the
   * oversell race cannot be reproduced, and a passing "concurrency test"
   * written against this harness would be exactly the false confidence that
   * broke the expired-batch test earlier in this project.
   *
   * To run it for real, two connections are needed:
   *   1. txn A: begin; select ... from batches where id = X for update;
   *   2. txn B: begin; select issue_stock(X, 20, ...)   -- must BLOCK here
   *   3. txn A: issue 20; commit;
   *   4. txn B unblocks, re-reads 10, and must fail with INSUFFICIENT_STOCK.
   *
   * That needs a real PostgreSQL server: `docker run postgres:18`, a local
   * install, or a Supabase branch database. It is the last unverified claim in
   * the security model and belongs in milestone 8's QA pass.
   */
  it.todo("two overlapping issues cannot oversell (needs two real connections)");
});

// ===========================================================================
describe("onboarding (0004)", () => {
// ===========================================================================

  const NEW_USER = "ffffffff-0000-4000-8000-000000000001";

  /** Simulates a Supabase sign-up: a row in auth.users and nothing else. */
  async function signUp(id: string, email: string, fullName: string) {
    await db.query(
      // $3 needs an explicit ::text cast: jsonb_build_object is variadic
      // "any", so PostgreSQL cannot infer a parameter's type from it and
      // raises "could not determine data type of parameter $3".
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, jsonb_build_object('full_name', $3::text))`,
      [id, email, fullName],
    );
  }

  it("creates a profile automatically on sign-up", async () => {
    await signUp(NEW_USER, "new@example.test", "New Person");
    const r = await db.query<{ full_name: string; email: string }>(
      "select full_name, email from profiles where id = $1",
      [NEW_USER],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].full_name).toBe("New Person");
    expect(r.rows[0].email).toBe("new@example.test");
  });

  it("a new user starts with no clinic and sees nothing", async () => {
    await signUp(NEW_USER, "new@example.test", "New Person");
    await asUser(db, NEW_USER, async () => {
      expect((await db.query("select * from products")).rows).toHaveLength(0);
      expect((await db.query("select * from organizations")).rows).toHaveLength(0);
    });
  });

  it("lets a new user found a clinic and become its administrator", async () => {
    await signUp(NEW_USER, "new@example.test", "New Person");
    await asUser(db, NEW_USER, async () => {
      const org = await db.query<{ id: string; name: string; timezone: string }>(
        "select * from create_organization($1, $2)",
        ["Riverside Clinic", "Africa/Lagos"],
      );
      expect(org.rows[0].name).toBe("Riverside Clinic");
      expect(org.rows[0].timezone).toBe("Africa/Lagos");

      const role = await db.query<{ role: string }>(
        "select role from organization_members where user_id = $1",
        [NEW_USER],
      );
      expect(role.rows[0].role).toBe("admin");

      // And can immediately do admin work in their own clinic.
      const product = await db.query(
        `insert into products (organization_id, name, sku, unit)
         values ($1, 'Gauze', 'CON-100', 'pack') returning id`,
        [org.rows[0].id],
      );
      expect(product.rows).toHaveLength(1);
    });
  });

  it("the founder's clinic is still invisible to everyone else", async () => {
    await signUp(NEW_USER, "new@example.test", "New Person");
    await asUser(db, NEW_USER, async () => {
      await db.query("select create_organization($1)", ["Riverside Clinic"]);
    });
    // Tenant isolation must hold for a clinic created at runtime, not just for
    // the ones the seed data set up.
    await asUser(db, ADMIN_A, async () => {
      const r = await db.query("select * from organizations where name = 'Riverside Clinic'");
      expect(r.rows).toHaveLength(0);
    });
  });

  it("refuses to create a clinic for an unauthenticated caller", async () => {
    const err = await expectFailure(() =>
      db.query("select create_organization($1)", ["Nobody's Clinic"]),
    );
    expect(err.detail).toBe("AUTH_REQUIRED");
  });

  it("refuses a blank name or an unknown timezone", async () => {
    await signUp(NEW_USER, "new@example.test", "New Person");
    await asUser(db, NEW_USER, async () => {
      const blank = await expectFailure(() =>
        db.query("select create_organization($1)", [" "]),
      );
      expect(blank.detail).toBe("INVALID_INPUT");

      const tz = await expectFailure(() =>
        db.query("select create_organization($1, $2)", ["Clinic", "Mars/Olympus"]),
      );
      expect(tz.detail).toBe("INVALID_INPUT");
    });
  });

  it("still blocks adding yourself to a clinic that already has members", async () => {
    // The founding exemption in 0004 is narrow: it applies only while an
    // organisation has NO members. This is the attack it must still stop --
    // brief section 3, "a user must not be able to grant themselves
    // administrator privileges".
    await signUp(NEW_USER, "new@example.test", "New Person");
    await asUser(db, NEW_USER, async () => {
      const err = await expectFailure(() =>
        db.query(
          `insert into organization_members (organization_id, user_id, role)
           values ($1, $2, 'admin')`,
          [ORG_A, NEW_USER],
        ),
      );
      // I expected 42501 here, from the RLS policy. It is P0001 from the
      // trigger, and PostgreSQL's order is the reason: a BEFORE trigger fires
      // BEFORE the policy's WITH CHECK expression is evaluated, because the
      // check applies to the final row the triggers produced. So the trigger
      // always speaks first.
      //
      // Both layers would refuse this -- the user is not an admin of Clinic A
      // either -- which is the point of having both. Worth knowing which one
      // answers, though: the error a user sees comes from the trigger.
      expect(err.detail).toBe("PERMISSION_DENIED");
    });
    const members = await db.query("select * from organization_members where user_id = $1", [NEW_USER]);
    expect(members.rows).toHaveLength(0);
  });

  it("blocks a founder from re-adding themselves to their own clinic", async () => {
    // This one DOES reach the trigger: the user is an admin of this clinic, so
    // the policy lets the statement through, and the trigger is what stops it.
    await signUp(NEW_USER, "new@example.test", "New Person");
    let orgId = "";
    await asUser(db, NEW_USER, async () => {
      const org = await db.query<{ id: string }>("select * from create_organization($1)", ["Riverside"]);
      orgId = org.rows[0].id;
      const err = await expectFailure(() =>
        db.query(
          `insert into organization_members (organization_id, user_id, role)
           values ($1, $2, 'viewer')`,
          [orgId, NEW_USER],
        ),
      );
      expect(err.detail).toBe("PERMISSION_DENIED");
    });
  });

  it("seeds default categories only for an administrator", async () => {
    await signUp(NEW_USER, "new@example.test", "New Person");
    await asUser(db, NEW_USER, async () => {
      const org = await db.query<{ id: string }>("select * from create_organization($1)", ["Riverside"]);
      const cats = await db.query("select * from seed_default_categories($1)", [org.rows[0].id]);
      expect(cats.rows).toHaveLength(3);
    });
    await asUser(db, VIEWER_A, async () => {
      const err = await expectFailure(() =>
        db.query("select seed_default_categories($1)", [ORG_A]),
      );
      expect(err.detail).toBe("PERMISSION_DENIED");
    });
  });
});

// ===========================================================================
describe("hardening (0005)", () => {
// ===========================================================================

  it("authenticates BEFORE looking anything up", async () => {
    // The flaw the live project revealed: with no JWT and a random UUID,
    // issue_stock used to answer BATCH_NOT_FOUND -- so an anonymous caller
    // could tell a real batch id from a fake one, because a real one in
    // another clinic answered PERMISSION_DENIED instead.
    //
    // An existence oracle, served to someone who has not signed in.
    await asUser(db, ADMIN_A, async () => {
      await db.exec("select set_config('request.jwt.claims', '', false);");
      for (const [sql, params] of [
        ["select issue_stock($1, 1, 'Ward usage')", ["00000000-0000-4000-8000-000000000000"]],
        ["select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]],
        ["select adjust_stock($1, -1, 'Recount')", [BATCH_A_GOOD]],
        ["select reverse_movement($1, 'Mistake')", ["00000000-0000-4000-8000-000000000000"]],
        ["select receive_stock($1, 'X', 1, current_date, null)", [PRODUCT_A]],
      ] as [string, unknown[]][]) {
        const err = await expectFailure(() => db.query(sql, params));
        // Same answer whether the id is real or invented.
        expect(err.detail).toBe("AUTH_REQUIRED");
      }
    });
  });

  it("rejects a bad quantity only AFTER authenticating", async () => {
    // Input validation also leaks: an anonymous caller who learns their
    // quantity was rejected has learned the endpoint is reachable. Auth first,
    // everything else after.
    await asUser(db, ADMIN_A, async () => {
      await db.exec("select set_config('request.jwt.claims', '', false);");
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, -5, '')", [BATCH_A_GOOD]),
      );
      expect(err.detail).toBe("AUTH_REQUIRED");
    });
  });

  it("gives anon no table privileges at all", async () => {
    // Supabase's default privileges had granted anon ALL on every public table.
    // RLS was refusing every row, so nothing leaked -- but the design called
    // for two locks and production was running on one.
    await db.exec("set role anon;");
    try {
      for (const t of ["products", "batches", "stock_movements", "organizations"]) {
        const err = await expectFailure(() => db.query(`select * from ${t} limit 1`));
        // "permission denied for table X" -- the grant is gone, so RLS is not
        // even consulted. Distinct from an RLS refusal, which returns no rows.
        expect(err.message).toMatch(/permission denied for table/i);
      }
    } finally {
      await db.exec("reset role;");
    }
  });

  it("gives anon no execute privilege on the stock functions", async () => {
    await db.exec("set role anon;");
    try {
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]),
      );
      expect(err.message).toMatch(/permission denied for function/i);
    } finally {
      await db.exec("reset role;");
    }
  });

  it("denies batch writes by GRANT, not merely by policy", async () => {
    // Both locks, verified separately. Before 0005 this failed with "new row
    // violates row-level security policy" -- correct, but one lock deep.
    await asUser(db, ADMIN_A, async () => {
      const update = await expectFailure(() =>
        db.query("update batches set quantity_on_hand = 999 where id = $1", [BATCH_A_GOOD]),
      );
      expect(update.message).toMatch(/permission denied for table batches/i);

      const insert = await expectFailure(() =>
        db.query(
          `insert into stock_movements (organization_id, batch_id, movement_type,
                                        quantity_delta, reason, performed_by)
           values ($1, $2, 'issue', -5, 'Invented', $3)`,
          [ORG_A, BATCH_A_GOOD, ADMIN_A],
        ),
      );
      expect(insert.message).toMatch(/permission denied for table stock_movements/i);
    });
    expect(await balance(BATCH_A_GOOD)).toBe(30);
  });

  it("still lets the legitimate paths work", async () => {
    // A hardening migration that quietly breaks the app is worse than the flaw
    // it fixed, so the happy path is re-asserted after every revoke.
    await asUser(db, OFFICER_A, async () => {
      const issued = await db.query<{ quantity_on_hand: number }>(
        "select * from issue_stock($1, 5, 'Ward usage')",
        [BATCH_A_GOOD],
      );
      expect(issued.rows[0].quantity_on_hand).toBe(25);

      const received = await db.query<{ quantity_on_hand: number }>(
        "select * from receive_stock($1, 'POST-0005', 60, current_date, current_date + 200)",
        [PRODUCT_A],
      );
      expect(received.rows[0].quantity_on_hand).toBe(60);

      const products = await db.query("select * from products");
      expect(products.rows).toHaveLength(1);
    });
  });
});
