/**
 * Database-level security and transaction tests (brief sections 8 and 11).
 *
 * These run the REAL migrations against a REAL PostgreSQL engine. What they
 * verify is not that our TypeScript is careful, but that the database refuses
 * things on its own -- which is the only check that counts, because a client
 * can always be bypassed.
 *
 * Every test gets a fresh database. Shared mutable state between security tests
 * is how you end up with a suite that passes in one order and leaks in another.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  ADMIN_A, ADMIN_B, BATCH_A_EXPIRED, BATCH_A_GOOD,
  OFFICER_A, ORG_A, ORG_B, PRODUCT_A, VIEWER_A,
  asUser, expectFailure, freshDb,
} from "./harness";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

afterEach(async () => {
  await db.close();
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
    // from the product row, finds Clinic B holds no role there, and refuses.
    await asUser(db, ADMIN_B, async () => {
      const err = await expectFailure(() =>
        db.query(`select receive_stock($1, 'CROSS', 10, current_date, null)`, [PRODUCT_A]),
      );
      expect(err.detail).toBe("PERMISSION_DENIED");
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

  it("a user with no membership is refused", async () => {
    await asUser(db, ADMIN_B, async () => {
      const err = await expectFailure(() =>
        db.query("select issue_stock($1, 1, 'Ward usage')", [BATCH_A_GOOD]),
      );
      // Not BATCH_NOT_FOUND: they are told nothing about whether it exists.
      expect(err.detail).toBe("PERMISSION_DENIED");
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
