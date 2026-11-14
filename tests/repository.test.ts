/**
 * End-to-end workflow tests against DemoInventoryRepository.
 *
 * Covers these brief section 11 rows:
 *   Add product / Duplicate SKU / Receive 100 units / Issue 20 units /
 *   Issue more than available / Adjustment -5 / Adjustment without reason /
 *   Add second batch / Expired batch issue / Viewer tries to change stock
 *
 * Each test gets a FRESH repository with a fresh MemoryStore. Tests that share
 * mutable state pass or fail depending on the order they run in, which makes
 * them worse than no tests -- they produce confident wrong answers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DemoInventoryRepository } from "@/repositories/demo/DemoInventoryRepository";
import { MemoryStore } from "@/repositories/demo/storage";
import { DEMO_ORG_ID, DEMO_USER_ID } from "@/repositories/demo/seed";
import type { ActorContext } from "@/repositories/InventoryRepository";
import type { Role } from "@/domain/types";
import { addDays } from "@/domain/dateOnly";
import { balanceFromMovements, productTotal } from "@/domain/stock";

const TODAY = "2026-11-14";

function actor(role: Role = "inventory_officer", org = DEMO_ORG_ID): ActorContext {
  return { user_id: DEMO_USER_ID, organization_id: org, role };
}

function makeRepo(role: Role = "inventory_officer", org = DEMO_ORG_ID) {
  return new DemoInventoryRepository(actor(role, org), new MemoryStore(), TODAY);
}

/** A valid receipt payload; individual tests override the field under test. */
function receipt(over: Record<string, unknown> = {}) {
  return {
    product_id: "prod-gauze",
    batch_number: "GZE-NEW-001",
    quantity: 100,
    received_at: TODAY,
    expiry_date: addDays(TODAY, 365),
    ...over,
  };
}

describe("seed data", () => {
  it("loads the brief's five synthetic products", async () => {
    const products = await makeRepo().getProducts();
    expect(products.map((p) => p.sku).sort()).toEqual([
      "CON-001", "CON-002", "CON-003", "CON-004", "MED-001",
    ]);
  });

  it("starts with history that agrees with every balance", async () => {
    // The audit invariant: signed movement deltas sum to quantity_on_hand. If
    // the seed violated this, every later reconciliation test would be
    // measuring against a lie.
    const repo = makeRepo();
    for (const b of await repo.getBatches()) {
      const movements = await repo.getMovementsForBatch(b.id);
      expect(balanceFromMovements(movements)).toBe(b.quantity_on_hand);
    }
  });
});

describe("add product", () => {
  it("appears in inventory afterwards", async () => {
    const repo = makeRepo();
    const result = await repo.createProduct({
      name: "Syringe 5ml", sku: "CON-005", unit: "piece",
      category_id: "cat-consumables", reorder_level: 60,
      description: null, is_active: true,
    });
    expect(result.ok).toBe(true);
    const skus = (await repo.getProducts()).map((p) => p.sku);
    expect(skus).toContain("CON-005");
  });

  it("rejects a duplicate SKU within the same clinic", async () => {
    const repo = makeRepo();
    const result = await repo.createProduct({
      name: "Another paracetamol", sku: "MED-001", unit: "tablet",
      category_id: "cat-medicines", reorder_level: 10,
      description: null, is_active: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DUPLICATE_SKU");
  });

  it("treats SKUs as case-insensitive, so med-001 is still a duplicate", async () => {
    const repo = makeRepo();
    const result = await repo.createProduct({
      name: "Sneaky duplicate", sku: "med-001", unit: "tablet",
      category_id: null, reorder_level: 10, description: null, is_active: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe("receive stock", () => {
  it("receiving 100 units increases the balance by 100 and records a receipt", async () => {
    const repo = makeRepo();
    const result = await repo.receiveStock(receipt());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.quantity_on_hand).toBe(100);
    const movements = await repo.getMovementsForBatch(result.value.id);
    expect(movements).toHaveLength(1);
    expect(movements[0].movement_type).toBe("receipt");
    expect(movements[0].quantity_delta).toBe(100);
    expect(movements[0].performed_by).toBe(DEMO_USER_ID);
    expect(movements[0].created_at).toBeTruthy();
  });

  it("adding a second batch recalculates the product total", async () => {
    const repo = makeRepo();
    const before = productTotal(await repo.getBatchesForProduct("prod-gauze"));
    expect(before).toBe(25);

    await repo.receiveStock(receipt({ quantity: 75 }));

    const after = productTotal(await repo.getBatchesForProduct("prod-gauze"));
    expect(after).toBe(100);
    expect(await repo.getBatchesForProduct("prod-gauze")).toHaveLength(2);
  });

  it("tops up an existing batch number instead of creating a duplicate row", async () => {
    const repo = makeRepo();
    const existing = (await repo.getBatchesForProduct("prod-gauze"))[0];
    const result = await repo.receiveStock(
      receipt({ batch_number: existing.batch_number, quantity: 10, expiry_date: existing.expiry_date }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(existing.id);
    expect(result.value.quantity_on_hand).toBe(35);
    expect(await repo.getBatchesForProduct("prod-gauze")).toHaveLength(1);
  });

  it("refuses to reuse a batch number with a different expiry date", async () => {
    const repo = makeRepo();
    const existing = (await repo.getBatchesForProduct("prod-gauze"))[0];
    const result = await repo.receiveStock(
      receipt({ batch_number: existing.batch_number, expiry_date: addDays(TODAY, 900) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DUPLICATE_BATCH_NUMBER");
  });

  it("rejects zero, negative and fractional quantities", async () => {
    const repo = makeRepo();
    for (const quantity of [0, -5, 2.5]) {
      const result = await repo.receiveStock(receipt({ quantity }));
      expect(result.ok, "quantity " + quantity + " should be rejected").toBe(false);
    }
  });

  it("flags an expiry date earlier than the receipt date", async () => {
    const repo = makeRepo();
    const result = await repo.receiveStock(
      receipt({ received_at: TODAY, expiry_date: addDays(TODAY, -5) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXPIRY_BEFORE_RECEIPT");
  });

  it("rejects a malformed date rather than storing a guess", async () => {
    const repo = makeRepo();
    const result = await repo.receiveStock(receipt({ received_at: "14/11/2026" }));
    expect(result.ok).toBe(false);
  });

  it("accepts stock with no expiry date", async () => {
    const repo = makeRepo();
    const result = await repo.receiveStock(receipt({ expiry_date: null }));
    expect(result.ok).toBe(true);
  });
});

describe("issue stock", () => {
  it("issuing 20 units decreases the batch by 20 and records an issue", async () => {
    const repo = makeRepo();
    const result = await repo.issueStock({
      batch_id: "batch-gauze-approaching", quantity: 20, reason: "Ward usage",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.quantity_on_hand).toBe(5); // seeded at 25
    const movements = await repo.getMovementsForBatch("batch-gauze-approaching");
    const issue = movements.find((m) => m.movement_type === "issue");
    expect(issue?.quantity_delta).toBe(-20);
    expect(issue?.reason).toBe("Ward usage");
    expect(issue?.performed_by).toBe(DEMO_USER_ID);
  });

  it("rejects issuing more than available and leaves the balance unchanged", async () => {
    const repo = makeRepo();
    const result = await repo.issueStock({
      batch_id: "batch-gauze-approaching", quantity: 26, reason: "Ward usage",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INSUFFICIENT_STOCK");
      // The message must tell staff what IS available -- "invalid input" sends
      // them back to the shelf to count by hand.
      expect(result.error.message).toContain("25");
    }

    const batches = await repo.getBatchesForProduct("prod-gauze");
    expect(batches[0].quantity_on_hand).toBe(25);
    // A rejected operation must leave NO trace in history either.
    const movements = await repo.getMovementsForBatch("batch-gauze-approaching");
    expect(movements.filter((m) => m.movement_type === "issue")).toHaveLength(0);
  });

  it("rejects issuing from an expired batch", async () => {
    const repo = makeRepo();
    const result = await repo.issueStock({
      batch_id: "batch-masks-expired", quantity: 1, reason: "Ward usage",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BATCH_EXPIRED");
  });

  it("requires a reason code for usage", async () => {
    const repo = makeRepo();
    const result = await repo.issueStock({
      batch_id: "batch-gauze-approaching", quantity: 1, reason: "  ",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown batch id", async () => {
    const repo = makeRepo();
    const result = await repo.issueStock({
      batch_id: "batch-does-not-exist", quantity: 1, reason: "Ward usage",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BATCH_NOT_FOUND");
  });
});

describe("adjustments", () => {
  it("an adjustment of -5 decreases the balance and records reason and actor", async () => {
    const repo = makeRepo();
    const result = await repo.adjustStock({
      batch_id: "batch-gauze-approaching", quantity_delta: -5,
      reason: "Damaged in storage",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.quantity_on_hand).toBe(20);
    const adjustment = (await repo.getMovementsForBatch("batch-gauze-approaching"))
      .find((m) => m.movement_type === "adjustment");
    expect(adjustment?.quantity_delta).toBe(-5);
    expect(adjustment?.reason).toBe("Damaged in storage");
    expect(adjustment?.performed_by).toBe(DEMO_USER_ID);
  });

  it("rejects an adjustment with no reason", async () => {
    const repo = makeRepo();
    const result = await repo.adjustStock({
      batch_id: "batch-gauze-approaching", quantity_delta: -5, reason: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a zero adjustment as audit noise", async () => {
    const repo = makeRepo();
    const result = await repo.adjustStock({
      batch_id: "batch-gauze-approaching", quantity_delta: 0, reason: "Recount",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an adjustment that would make the balance negative", async () => {
    const repo = makeRepo();
    const result = await repo.adjustStock({
      batch_id: "batch-gauze-approaching", quantity_delta: -26, reason: "Recount",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSUFFICIENT_STOCK");
  });

  it("ALLOWS writing off an expired batch", async () => {
    // Blocking this would trap expired units on the books forever. Recording
    // the write-off is exactly what the clinic needs to do.
    const repo = makeRepo();
    const result = await repo.adjustStock({
      batch_id: "batch-masks-expired", quantity_delta: -40,
      reason: "Expired stock written off",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.quantity_on_hand).toBe(0);
  });
});

describe("reversal, not deletion", () => {
  it("compensates with a new movement and leaves the original intact", async () => {
    const repo = makeRepo();
    const issued = await repo.issueStock({
      batch_id: "batch-gauze-approaching", quantity: 10, reason: "Ward usage",
    });
    expect(issued.ok).toBe(true);

    const issue = (await repo.getMovementsForBatch("batch-gauze-approaching"))
      .find((m) => m.movement_type === "issue")!;

    const reversed = await repo.reverseMovement(issue.id, "Issued against the wrong batch");
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.value.quantity_on_hand).toBe(25); // back to the start

    const movements = await repo.getMovementsForBatch("batch-gauze-approaching");
    // The original issue is STILL THERE. History shows the mistake and the
    // correction, which is what makes the trail auditable.
    expect(movements.find((m) => m.id === issue.id)).toBeDefined();
    const reversal = movements.find((m) => m.movement_type === "reversal");
    expect(reversal?.quantity_delta).toBe(10);
    expect(reversal?.reverses_movement_id).toBe(issue.id);

    // And the invariant still holds after all that.
    expect(balanceFromMovements(movements)).toBe(25);
  });

  it("refuses to reverse the same movement twice", async () => {
    const repo = makeRepo();
    const issue = (await repo.getMovementsForBatch("batch-gauze-approaching"))[0];
    await repo.reverseMovement(issue.id, "First reversal");
    const second = await repo.reverseMovement(issue.id, "Second reversal");
    expect(second.ok).toBe(false);
  });

  it("requires a reason", async () => {
    const repo = makeRepo();
    const issue = (await repo.getMovementsForBatch("batch-gauze-approaching"))[0];
    expect((await repo.reverseMovement(issue.id, "")).ok).toBe(false);
  });
});

describe("role permissions (usability layer, NOT the security boundary)", () => {
  let viewer: DemoInventoryRepository;
  beforeEach(() => {
    viewer = makeRepo("viewer");
  });

  it("a viewer cannot receive, issue or adjust stock", async () => {
    const results = [
      await viewer.receiveStock(receipt()),
      await viewer.issueStock({ batch_id: "batch-gauze-approaching", quantity: 1, reason: "Ward usage" }),
      await viewer.adjustStock({ batch_id: "batch-gauze-approaching", quantity_delta: -1, reason: "Recount" }),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("PERMISSION_DENIED");
    }
  });

  it("a viewer cannot add products", async () => {
    const result = await viewer.createProduct({
      name: "X", sku: "X-1", unit: "piece", category_id: null,
      reorder_level: 1, description: null, is_active: true,
    });
    expect(result.ok).toBe(false);
  });

  it("a viewer CAN still read inventory", async () => {
    expect((await viewer.getProducts()).length).toBeGreaterThan(0);
  });

  /**
   * NOT A SECURITY TEST. This proves the buttons are correctly disabled, which
   * is a usability property. A determined user bypasses all of it from the
   * console. The real test -- the database refusing the write -- belongs to
   * milestone 5, against PostgreSQL RLS and the SQL functions.
   */
  it.todo("milestone 5: the DATABASE rejects a viewer's write, not just the client");
});

describe("tenant scoping (demo-mode shape only)", () => {
  it("returns nothing for a different organisation", async () => {
    const other = makeRepo("admin", "org-some-other-clinic");
    expect(await other.getProducts()).toEqual([]);
    expect(await other.getBatches()).toEqual([]);
  });

  it("cannot issue stock belonging to another organisation", async () => {
    const other = makeRepo("admin", "org-some-other-clinic");
    const result = await other.issueStock({
      batch_id: "batch-gauze-approaching", quantity: 1, reason: "Ward usage",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BATCH_NOT_FOUND");
  });

  /**
   * Brief section 11: "Clinic A queries Clinic B -> no data is returned".
   * Demo mode cannot honestly test this: one browser, one dataset, and the
   * filtering is done by the same code being tested. Real tenant isolation is
   * a Row Level Security property and gets a real test in milestone 5.
   */
  it.todo("milestone 5: RLS denies cross-tenant reads at the database level");
});

describe("deferred to milestone 5", () => {
  /**
   * Brief section 11: "Concurrent stock issue -> no overselling".
   * Untestable here, and NOT because it is hard -- because demo mode genuinely
   * cannot provide the guarantee. JavaScript has no row lock, so two tabs can
   * interleave read-modify-write and oversell. Writing a passing "concurrency
   * test" against this repository would manufacture false confidence in the
   * exact area the brief calls the critical implementation rule.
   */
  it.todo("milestone 5: two concurrent issues cannot oversell (SELECT ... FOR UPDATE)");
});

describe("reset demo data", () => {
  it("restores the seeded dataset", async () => {
    const repo = makeRepo();
    await repo.issueStock({ batch_id: "batch-gauze-approaching", quantity: 20, reason: "Ward usage" });
    expect((await repo.getBatchesForProduct("prod-gauze"))[0].quantity_on_hand).toBe(5);

    repo.resetDemoData();
    expect((await repo.getBatchesForProduct("prod-gauze"))[0].quantity_on_hand).toBe(25);
  });
});
