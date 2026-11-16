/**
 * View-model tests.
 *
 * These exist because the dashboard, the inventory table and (in milestone 7)
 * the CSV export all read these same functions. A bug here shows up as three
 * screens disagreeing about the same number, which is the single fastest way to
 * lose a clinic's trust in the software.
 */
import { describe, expect, it } from "vitest";
import type { Batch, Product } from "@/domain/types";
import { addDays } from "@/domain/dateOnly";
import { buildDashboardSummary, buildProductRows, matchesSearch } from "@/domain/inventoryView";

const TODAY = "2026-11-14";

function product(over: Partial<Product> & { id: string }): Product {
  return {
    organization_id: "org-1",
    category_id: "cat-1",
    name: "Test product",
    sku: "TST-001",
    unit: "box",
    reorder_level: 10,
    description: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function batch(over: Partial<Batch> & { id: string; product_id: string }): Batch {
  return {
    organization_id: "org-1",
    supplier_id: null,
    batch_number: over.id.toUpperCase(),
    quantity_on_hand: 10,
    unit_cost: null,
    received_at: addDays(TODAY, -30),
    expiry_date: addDays(TODAY, 120),
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildProductRows", () => {
  it("rolls many batches up into one row", () => {
    const rows = buildProductRows(
      [product({ id: "p1", reorder_level: 100 })],
      [
        batch({ id: "b1", product_id: "p1", quantity_on_hand: 60 }),
        batch({ id: "b2", product_id: "p1", quantity_on_hand: 80 }),
      ],
      TODAY,
    );
    expect(rows[0].total).toBe(140);
    expect(rows[0].batchCount).toBe(2);
    expect(rows[0].low).toBe(false);
  });

  it("shows the MOST URGENT batch status for the row", () => {
    // A product with one valid batch and one expired batch is not "valid".
    // Showing the best status would hide the problem the row exists to surface.
    const rows = buildProductRows(
      [product({ id: "p1" })],
      [
        batch({ id: "fine", product_id: "p1", expiry_date: addDays(TODAY, 300) }),
        batch({ id: "dead", product_id: "p1", expiry_date: addDays(TODAY, -1) }),
      ],
      TODAY,
    );
    expect(rows[0].worstStatus).toBe("expired");
  });

  it("ignores empty batches when deciding the row status", () => {
    // A used-up batch that expired last year is not news. Letting it set the
    // status would leave products permanently red for no reason.
    const rows = buildProductRows(
      [product({ id: "p1" })],
      [
        batch({ id: "spent", product_id: "p1", quantity_on_hand: 0, expiry_date: addDays(TODAY, -400) }),
        batch({ id: "good", product_id: "p1", quantity_on_hand: 50, expiry_date: addDays(TODAY, 300) }),
      ],
      TODAY,
    );
    expect(rows[0].worstStatus).toBe("valid");
    expect(rows[0].batchCount).toBe(1);
  });

  it("reports a product with no batches as empty rather than crashing", () => {
    const rows = buildProductRows([product({ id: "p1" })], [], TODAY);
    expect(rows[0].total).toBe(0);
    expect(rows[0].low).toBe(true);
    expect(rows[0].worstStatus).toBe("no_expiry_recorded");
    expect(rows[0].earliestExpiry).toBeNull();
  });

  it("separates total from usable when stock has expired", () => {
    const rows = buildProductRows(
      [product({ id: "p1" })],
      [
        batch({ id: "ok", product_id: "p1", quantity_on_hand: 90, expiry_date: addDays(TODAY, 1) }),
        batch({ id: "dead", product_id: "p1", quantity_on_hand: 40, expiry_date: addDays(TODAY, -1) }),
      ],
      TODAY,
    );
    expect(rows[0].total).toBe(130);
    expect(rows[0].issuable).toBe(90);
  });

  it("honours a clinic's configured warning window", () => {
    const batches = [batch({ id: "b1", product_id: "p1", expiry_date: addDays(TODAY, 20) })];
    expect(buildProductRows([product({ id: "p1" })], batches, TODAY)[0].worstStatus).toBe("expiring_soon");
    expect(
      buildProductRows([product({ id: "p1" })], batches, TODAY, { soonDays: 7, approachingDays: 60 })[0].worstStatus,
    ).toBe("approaching_expiry");
  });

  it("picks the earliest expiry date among stocked batches", () => {
    const rows = buildProductRows(
      [product({ id: "p1" })],
      [
        batch({ id: "late", product_id: "p1", expiry_date: addDays(TODAY, 300) }),
        batch({ id: "early", product_id: "p1", expiry_date: addDays(TODAY, 40) }),
        batch({ id: "undated", product_id: "p1", expiry_date: null }),
      ],
      TODAY,
    );
    expect(rows[0].earliestExpiry).toBe(addDays(TODAY, 40));
  });
});

describe("buildDashboardSummary", () => {
  const products = [
    product({ id: "p1", reorder_level: 100 }),
    product({ id: "p2", reorder_level: 40 }),
    product({ id: "p3", is_active: false, reorder_level: 10 }),
  ];
  const batches = [
    batch({ id: "b1", product_id: "p1", quantity_on_hand: 140, expiry_date: addDays(TODAY, 300) }),
    batch({ id: "b2", product_id: "p2", quantity_on_hand: 25, expiry_date: addDays(TODAY, 45) }),
    batch({ id: "b3", product_id: "p2", quantity_on_hand: 40, expiry_date: addDays(TODAY, -2) }),
    batch({ id: "b4", product_id: "p3", quantity_on_hand: 5, expiry_date: null }),
  ];
  const summary = buildDashboardSummary(
    buildProductRows(products, batches, TODAY),
    batches,
    TODAY,
  );

  it("counts only ACTIVE products", () => {
    // A deactivated product should not inflate the count of things the clinic
    // is managing, nor appear in the low-stock figure staff act on.
    expect(summary.totalProducts).toBe(2);
  });

  it("counts low stock among active products only", () => {
    // p1: 140 vs reorder 100 -> not low. p2: 65 vs 40 -> not low.
    // p3: 5 vs reorder 10 -> IS low, but inactive, so excluded. Hence 0.
    // (This assertion was wrong on first write -- I expected 1. The code was
    //  right and the test was wrong, which is the more common case than people
    //  expect. Always check which one is lying before "fixing" the code.)
    expect(summary.lowStockCount).toBe(0);
  });

  it("counts batches by expiry band", () => {
    expect(summary.expiredBatches).toBe(1);
    expect(summary.approachingBatches).toBe(1);
    expect(summary.noExpiryBatches).toBe(1);
  });

  it("reports the units locked up in expired batches", () => {
    expect(summary.expiredUnits).toBe(40);
    expect(summary.totalUnits - summary.issuableUnits).toBe(40);
  });
});

describe("matchesSearch", () => {
  const row = buildProductRows(
    [product({ id: "p1", name: "Paracetamol 500mg", sku: "MED-001" })],
    [],
    TODAY,
  )[0];

  it("matches name and SKU, case-insensitively", () => {
    expect(matchesSearch(row, "paracet")).toBe(true);
    expect(matchesSearch(row, "med-001")).toBe(true);
    expect(matchesSearch(row, "MED")).toBe(true);
  });

  it("treats blank and whitespace queries as no filter", () => {
    expect(matchesSearch(row, "")).toBe(true);
    expect(matchesSearch(row, "   ")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesSearch(row, "gloves")).toBe(false);
  });
});
