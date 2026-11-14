/**
 * Stock totals, low stock and FEFO -- brief section 11 rows:
 *   "Add second batch", "FEFO recommendation".
 *
 * These are pure functions, so each test builds exactly the batches it needs.
 * A test that depends on shared seed data breaks when the seed changes for an
 * unrelated reason.
 */
import { describe, expect, it } from "vitest";
import type { Batch } from "@/domain/types";
import { addDays } from "@/domain/dateOnly";
import {
  balanceFromMovements,
  isLowStock,
  issuableBatches,
  issuableTotal,
  productTotal,
  recommendFefoBatch,
} from "@/domain/stock";

const TODAY = "2026-11-14";

/** Minimal batch factory: only the fields these rules actually read. */
function batch(over: Partial<Batch> & { id: string }): Batch {
  return {
    organization_id: "org-1",
    product_id: "prod-1",
    supplier_id: null,
    batch_number: over.id.toUpperCase(),
    quantity_on_hand: 10,
    unit_cost: null,
    received_at: addDays(TODAY, -30),
    expiry_date: addDays(TODAY, 90),
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

describe("productTotal", () => {
  it("sums batch balances", () => {
    const total = productTotal([
      batch({ id: "a", quantity_on_hand: 60 }),
      batch({ id: "b", quantity_on_hand: 80 }),
    ]);
    expect(total).toBe(140);
  });

  it("is 0 for a product with no batches, not undefined or NaN", () => {
    expect(productTotal([])).toBe(0);
  });

  it("INCLUDES expired batches -- they are real units awaiting write-off", () => {
    const batches = [
      batch({ id: "good", quantity_on_hand: 90, expiry_date: addDays(TODAY, 1) }),
      batch({ id: "dead", quantity_on_hand: 40, expiry_date: addDays(TODAY, -1) }),
    ];
    expect(productTotal(batches)).toBe(130);
    // ...but they cannot be issued, so the usable figure is different. Showing
    // the clinic only one of these two numbers is how a stock room ends up
    // trusting 130 units it cannot legally use.
    expect(issuableTotal(batches, TODAY)).toBe(90);
  });
});

describe("isLowStock", () => {
  it("is true AT the reorder level, not one unit below", () => {
    // The brief's formula is `total <= reorder_level`. Using `<` would tell the
    // clinic to restock only after it has already dipped under the safe level.
    expect(isLowStock(40, 40)).toBe(true);
    expect(isLowStock(41, 40)).toBe(false);
    expect(isLowStock(39, 40)).toBe(true);
  });

  it("treats zero stock as low", () => {
    expect(isLowStock(0, 20)).toBe(true);
  });
});

describe("issuableBatches", () => {
  it("excludes expired and empty batches", () => {
    const ids = issuableBatches(
      [
        batch({ id: "ok" }),
        batch({ id: "expired", expiry_date: addDays(TODAY, -1) }),
        batch({ id: "empty", quantity_on_hand: 0 }),
      ],
      TODAY,
    ).map((b) => b.id);
    expect(ids).toEqual(["ok"]);
  });
});

describe("recommendFefoBatch", () => {
  it("recommends the earliest-expiring eligible batch", () => {
    const result = recommendFefoBatch(
      [
        batch({ id: "later", expiry_date: addDays(TODAY, 300) }),
        batch({ id: "soonest", expiry_date: addDays(TODAY, 20) }),
        batch({ id: "middle", expiry_date: addDays(TODAY, 60) }),
      ],
      TODAY,
    );
    expect(result?.batch.id).toBe("soonest");
    expect(result?.basis).toBe("expiry");
    expect(result?.daysToExpiry).toBe(20);
  });

  it("never recommends an expired batch, even if it expires soonest", () => {
    const result = recommendFefoBatch(
      [
        batch({ id: "expired", expiry_date: addDays(TODAY, -2) }),
        batch({ id: "usable", expiry_date: addDays(TODAY, 40) }),
      ],
      TODAY,
    );
    expect(result?.batch.id).toBe("usable");
  });

  it("prefers dated stock over undated stock", () => {
    // Dated stock is the stock that can actually be lost to expiry, so using it
    // first is the entire purpose of FEFO.
    const result = recommendFefoBatch(
      [
        batch({ id: "undated", expiry_date: null, received_at: addDays(TODAY, -300) }),
        batch({ id: "dated", expiry_date: addDays(TODAY, 200) }),
      ],
      TODAY,
    );
    expect(result?.batch.id).toBe("dated");
    expect(result?.basis).toBe("expiry");
  });

  it("falls back to oldest receipt date when NOTHING has an expiry date", () => {
    const result = recommendFefoBatch(
      [
        batch({ id: "newer", expiry_date: null, received_at: addDays(TODAY, -5) }),
        batch({ id: "older", expiry_date: null, received_at: addDays(TODAY, -90) }),
      ],
      TODAY,
    );
    expect(result?.batch.id).toBe("older");
    // The basis is reported so the UI can say "oldest receipt" rather than
    // implying these batches were ranked by expiry. The brief: "never imply
    // FEFO can rank undated stock."
    expect(result?.basis).toBe("receipt_date_fallback");
    expect(result?.daysToExpiry).toBeNull();
  });

  it("returns null when every batch is expired or empty", () => {
    const result = recommendFefoBatch(
      [
        batch({ id: "expired", expiry_date: addDays(TODAY, -1) }),
        batch({ id: "empty", quantity_on_hand: 0 }),
      ],
      TODAY,
    );
    expect(result).toBeNull();
  });

  it("returns null for a product with no batches", () => {
    expect(recommendFefoBatch([], TODAY)).toBeNull();
  });

  it("breaks ties deterministically so the UI does not flicker", () => {
    const same = addDays(TODAY, 30);
    const batches = [
      batch({ id: "b", expiry_date: same, received_at: addDays(TODAY, -10) }),
      batch({ id: "a", expiry_date: same, received_at: addDays(TODAY, -50) }),
    ];
    expect(recommendFefoBatch(batches, TODAY)?.batch.id).toBe("a");
    expect(recommendFefoBatch([...batches].reverse(), TODAY)?.batch.id).toBe("a");
  });
});

describe("balanceFromMovements", () => {
  it("sums signed deltas", () => {
    expect(
      balanceFromMovements([
        { quantity_delta: 100 },
        { quantity_delta: -20 },
        { quantity_delta: -5 },
      ] as never),
    ).toBe(75);
  });
});
