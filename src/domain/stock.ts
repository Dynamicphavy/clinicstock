/**
 * Stock totals, low-stock detection and FEFO batch selection
 * (brief section 7).
 */
import type { Batch, DateOnly, StockMovement } from "./types";
import { daysToExpiry, isExpired } from "./expiry";

/**
 * Total units of a product: the sum of its batch balances.
 *
 *   product_total = SUM(batch.quantity_on_hand)
 *
 * DERIVED, never stored. A stored total would be a second source of truth and
 * would eventually disagree with the batches; a derived one cannot.
 *
 * Expired batches ARE included here. They are real units sitting on the shelf
 * and must stay visible for audit and write-off (brief section 7: "Expired
 * batches must remain visible for audit/reporting but cannot be issued").
 * Use `issuableTotal` for the figure that answers "how much can we use?".
 */
export function productTotal(batches: Batch[]): number {
  return batches.reduce((sum, b) => sum + b.quantity_on_hand, 0);
}

/** Units a clinic could actually issue today: excludes expired batches. */
export function issuableTotal(batches: Batch[], today: DateOnly): number {
  return batches
    .filter((b) => !isExpired(b.expiry_date, today))
    .reduce((sum, b) => sum + b.quantity_on_hand, 0);
}

/**
 * Low stock test from the brief: `low_stock = product_total <= reorder_level`.
 *
 * Note it is `<=`, not `<`. Sitting exactly ON the reorder level is the moment
 * to reorder, not one unit later. Off-by-one here means the clinic is told to
 * restock after it has already dipped below the safe level.
 */
export function isLowStock(total: number, reorderLevel: number): boolean {
  return total <= reorderLevel;
}

/** Batches that may legally be issued from today: in date and non-empty. */
export function issuableBatches(batches: Batch[], today: DateOnly): Batch[] {
  return batches.filter(
    (b) => b.quantity_on_hand > 0 && !isExpired(b.expiry_date, today),
  );
}

/**
 * How a FEFO recommendation was reached. Surfaced in the UI so staff are never
 * told that undated stock was "ranked by expiry" when it was not.
 */
export type FefoBasis = "expiry" | "receipt_date_fallback";

export interface FefoRecommendation {
  batch: Batch;
  basis: FefoBasis;
  /** Null when the recommendation came from the receipt-date fallback. */
  daysToExpiry: number | null;
}

/**
 * Recommend the batch to issue from, First Expiry First Out.
 *
 * Returns null when nothing is issuable (no stock, or every batch expired).
 *
 * The brief is specific about undated stock: "If expiry dates are absent, use a
 * documented fallback such as oldest receipt date; never imply FEFO can rank
 * undated stock." So this function works in two tiers:
 *
 *   1. If ANY issuable batch has an expiry date, recommend the earliest of
 *      those. Dated stock always takes priority -- it is the stock that can
 *      actually be lost to expiry, so using it first is the point of FEFO.
 *   2. Only if NO issuable batch has a date do we fall back to oldest receipt
 *      date, and we say so via `basis`.
 *
 * Ties (same expiry date) are broken by earlier receipt date, then by batch id,
 * so the recommendation is deterministic -- an unstable recommendation would
 * make the UI flicker between equally valid batches and make tests flaky.
 */
export function recommendFefoBatch(
  batches: Batch[],
  today: DateOnly,
): FefoRecommendation | null {
  const eligible = issuableBatches(batches, today);
  if (eligible.length === 0) return null;

  const dated = eligible.filter((b) => b.expiry_date !== null);

  if (dated.length > 0) {
    const sorted = [...dated].sort(
      (a, b) =>
        a.expiry_date!.localeCompare(b.expiry_date!) ||
        a.received_at.localeCompare(b.received_at) ||
        a.id.localeCompare(b.id),
    );
    const batch = sorted[0];
    return {
      batch,
      basis: "expiry",
      daysToExpiry: daysToExpiry(batch.expiry_date, today),
    };
  }

  const sorted = [...eligible].sort(
    (a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id),
  );
  return { batch: sorted[0], basis: "receipt_date_fallback", daysToExpiry: null };
}

/**
 * Sum of signed movement deltas for a batch.
 *
 * This must always equal the batch's `quantity_on_hand`. If it ever does not,
 * either a quantity was written without a movement (the bug the brief's
 * "critical implementation rule" exists to prevent) or history was tampered
 * with. Worth asserting in tests and worth a reconciliation report later.
 */
export function balanceFromMovements(movements: StockMovement[]): number {
  return movements.reduce((sum, m) => sum + m.quantity_delta, 0);
}
