/**
 * Synthetic demo dataset (brief section 9).
 *
 * SYNTHETIC ONLY. No patient-identifiable or clinical data, ever (section 8).
 *
 * Built RELATIVE to a supplied `today` rather than with hard-coded dates, so
 * the demo keeps showing one of each expiry band however long after it was
 * written -- a fixed "2026-12-01" would quietly become "expired" and the demo
 * would stop demonstrating anything.
 *
 * Ids are readable strings rather than UUIDs so tests and the audit trail are
 * legible. The Supabase implementation will use real UUIDs.
 */
import type { Batch, Category, Product, StockMovement } from "@/domain/types";
import type { DateOnly } from "@/domain/types";
import { addDays } from "@/domain/dateOnly";

export const DEMO_ORG_ID = "org-demo-clinic";
export const DEMO_USER_ID = "user-demo-admin";
export const DEMO_ORG_NAME = "Demo Clinic (synthetic data)";

export interface DemoDataset {
  categories: Category[];
  products: Product[];
  batches: Batch[];
  movements: StockMovement[];
}

export function buildDemoDataset(today: DateOnly): DemoDataset {
  const org = DEMO_ORG_ID;
  const createdAt = new Date().toISOString();

  const categories: Category[] = [
    { id: "cat-medicines", organization_id: org, name: "Medicines", description: "Oral and injectable medicines" },
    { id: "cat-consumables", organization_id: org, name: "Consumables", description: "Single-use clinical consumables" },
  ];

  const product = (
    id: string,
    name: string,
    sku: string,
    category_id: string,
    unit: string,
    reorder_level: number,
  ): Product => ({
    id, organization_id: org, category_id, name, sku, unit, reorder_level,
    description: null, is_active: true, created_at: createdAt,
  });

  // The five products from the brief's table, with the brief's reorder levels.
  const products: Product[] = [
    product("prod-paracetamol", "Paracetamol 500mg", "MED-001", "cat-medicines", "tablet", 100),
    product("prod-gloves", "Disposable gloves", "CON-001", "cat-consumables", "box", 50),
    product("prod-gauze", "Gauze swabs", "CON-002", "cat-consumables", "pack", 40),
    product("prod-masks", "Surgical masks", "CON-003", "cat-consumables", "box", 100),
    product("prod-sanitiser", "Hand sanitiser 500ml", "CON-004", "cat-consumables", "bottle", 20),
  ];

  const batch = (
    id: string,
    product_id: string,
    batch_number: string,
    quantity_on_hand: number,
    receivedDaysAgo: number,
    expiryInDays: number | null,
  ): Batch => ({
    id, organization_id: org, product_id, supplier_id: null, batch_number,
    quantity_on_hand, unit_cost: null,
    received_at: addDays(today, -receivedDaysAgo),
    expiry_date: expiryInDays === null ? null : addDays(today, expiryInDays),
    created_at: createdAt,
  });

  /**
   * Chosen so the demo shows every expiry band and both low-stock outcomes:
   *
   *   paracetamol 140 units, reorder 100 -> healthy; two batches, so FEFO has
   *                                         a real decision to make
   *   gloves      200 units, no expiry   -> exercises the undated fallback
   *   gauze        25 units, reorder 40  -> LOW STOCK, approaching expiry
   *   masks       130 units total but only 90 issuable: one batch expired
   *                                         yesterday. Shows why total and
   *                                         issuable total are different numbers.
   *   sanitiser    15 units, reorder 20  -> LOW STOCK, valid
   */
  const batches: Batch[] = [
    batch("batch-para-soon",  "prod-paracetamol", "PARA-2026-A", 60,  40, 20),
    batch("batch-para-valid", "prod-paracetamol", "PARA-2026-B", 80,  10, 300),
    batch("batch-gloves-undated", "prod-gloves",  "GLV-2026-A", 200, 25, null),
    batch("batch-gauze-approaching", "prod-gauze", "GZE-2026-A", 25, 30, 45),
    batch("batch-masks-expired", "prod-masks",    "MSK-2025-A", 40, 400, -1),
    batch("batch-masks-tomorrow", "prod-masks",   "MSK-2026-B", 90,  60, 1),
    batch("batch-sanitiser-valid", "prod-sanitiser", "SAN-2026-A", 15, 15, 200),
  ];

  /**
   * One receipt movement per batch, so the audit invariant holds from the start:
   * the signed deltas for a batch sum to its quantity_on_hand. If seed data
   * broke that, every reconciliation test would start from a lie.
   */
  const movements: StockMovement[] = batches.map((b, i) => ({
    id: "mov-seed-" + String(i + 1).padStart(3, "0"),
    organization_id: org,
    batch_id: b.id,
    movement_type: "receipt",
    quantity_delta: b.quantity_on_hand,
    reason: "Opening stock (synthetic demo data)",
    notes: null,
    performed_by: DEMO_USER_ID,
    created_at: new Date(Date.parse(b.received_at + "T09:00:00.000Z")).toISOString(),
    reverses_movement_id: null,
  }));

  return { categories, products, batches, movements };
}
