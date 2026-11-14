/**
 * ClinicStock domain types.
 *
 * Mirrors the tables in brief section 6. Kept free of React, Supabase and any
 * I/O so the same definitions can be used by the UI, the demo repository and
 * the tests.
 */

/** Roles from brief section 3. */
export type Role = "admin" | "inventory_officer" | "viewer";

/**
 * Movement types. Append-only: a mistake produces a `reversal`, never an edit
 * or delete of the original row (brief section 7).
 */
export type MovementType = "receipt" | "issue" | "adjustment" | "reversal";

/**
 * A calendar date with no time and no timezone, as "YYYY-MM-DD".
 *
 * Expiry and receipt are calendar facts, not instants. A batch expires on the
 * 31st everywhere; it does not expire at 00:00 in one timezone and 01:00 in
 * another. Storing these as Date/timestamptz is how "expires tomorrow" silently
 * becomes "expired" for a user a few hours east. Event timestamps
 * (`created_at`) are different -- those are true instants and stay timestamptz.
 */
export type DateOnly = string;

/** An ISO-8601 instant, e.g. "2026-11-14T09:30:00.000Z". */
export type Timestamp = string;

/** Product master record. Deliberately holds NO quantity -- see Batch. */
export interface Product {
  id: string;
  organization_id: string;
  category_id: string | null;
  name: string;
  /** Unique within an organisation (brief section 6). */
  sku: string;
  /** Counting unit, e.g. "box", "piece". Agreed with the clinic. */
  unit: string;
  /** At or below this total, the product is low stock. */
  reorder_level: number;
  description: string | null;
  is_active: boolean;
  created_at: Timestamp;
}

/**
 * A physical consignment of one product.
 *
 * This is the ONLY place a quantity lives. Two deliveries of the same product
 * can expire on different dates, so a single per-product number cannot answer
 * "what expires this month?".
 */
export interface Batch {
  id: string;
  organization_id: string;
  product_id: string;
  supplier_id: string | null;
  batch_number: string;
  /** Integer units. Never mutated from the browser (brief section 7). */
  quantity_on_hand: number;
  /** Money as a decimal string, never a JS number -- see note below. */
  unit_cost: string | null;
  received_at: DateOnly;
  /** Null means no expiry recorded, which is NOT the same as "never expires". */
  expiry_date: DateOnly | null;
  created_at: Timestamp;
}

/**
 * One immutable line of stock history.
 *
 * `quantity_delta` is signed: +100 received, -20 issued. Summing the deltas for
 * a batch must always equal its `quantity_on_hand`; that identity is what makes
 * the audit trail trustworthy, and the tests assert it.
 */
export interface StockMovement {
  id: string;
  organization_id: string;
  batch_id: string;
  movement_type: MovementType;
  quantity_delta: number;
  reason: string | null;
  notes: string | null;
  performed_by: string;
  created_at: Timestamp;
  /** Set on a reversal, pointing at the movement being compensated. */
  reverses_movement_id?: string | null;
}

export interface Category {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
}

/** Operational expiry bands from brief section 7. */
export type ExpiryStatus =
  | "expired"
  | "expiring_soon"
  | "approaching_expiry"
  | "valid"
  | "no_expiry_recorded";

/**
 * Configurable warning window. The brief calls these "configurable operational
 * warning bands, not a statement that a product is safe to use".
 */
export interface ExpiryBands {
  /** Days remaining at or below which stock is "expiring soon". Default 30. */
  soonDays: number;
  /** Days remaining at or below which stock is "approaching expiry". Default 60. */
  approachingDays: number;
}

export const DEFAULT_EXPIRY_BANDS: ExpiryBands = {
  soonDays: 30,
  approachingDays: 60,
};
