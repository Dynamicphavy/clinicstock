/**
 * View models: the numbers the screens display, derived from products and
 * batches.
 *
 * WHY THIS IS IN `domain/` AND NOT IN A COMPONENT: the inventory table, the
 * dashboard tiles and (in milestone 7) the CSV export all need "total units,
 * is it low, what is the most urgent expiry". Computed inline in JSX, that
 * logic gets written three times and the three copies drift -- the export says
 * 140 while the table says 130 and nobody can say which is right.
 *
 * Pure functions, so they are also testable without rendering anything.
 */
import type {
  Batch,
  DateOnly,
  ExpiryBands,
  ExpiryStatus,
  Product,
} from "./types";
import { DEFAULT_EXPIRY_BANDS } from "./types";
import { expiryStatus, isExpired } from "./expiry";
import { isLowStock, issuableTotal, productTotal } from "./stock";

export interface ProductRow {
  product: Product;
  /** Everything on the shelf, expired stock included. */
  total: number;
  /** What could actually be issued today. */
  issuable: number;
  low: boolean;
  batchCount: number;
  /** The most urgent status among batches that still hold stock. */
  worstStatus: ExpiryStatus;
  earliestExpiry: DateOnly | null;
}

/**
 * Urgency order for rolling many batch statuses up into one row status.
 * Lower number = more urgent = what the row should show.
 */
const URGENCY: Record<ExpiryStatus, number> = {
  expired: 0,
  expiring_soon: 1,
  approaching_expiry: 2,
  valid: 3,
  no_expiry_recorded: 4,
};

export function buildProductRows(
  products: Product[],
  batches: Batch[],
  today: DateOnly,
  bands: ExpiryBands = DEFAULT_EXPIRY_BANDS,
): ProductRow[] {
  return products.map((product) => {
    const own = batches.filter((b) => b.product_id === product.id);
    // Empty batches are ignored for the status roll-up: a used-up batch that
    // expired last year is not news, and letting it set the row status would
    // leave every product permanently red.
    const stocked = own.filter((b) => b.quantity_on_hand > 0);

    const statuses = stocked.map((b) => expiryStatus(b.expiry_date, today, bands));
    const worstStatus = statuses.length
      ? statuses.reduce((worst, s) => (URGENCY[s] < URGENCY[worst] ? s : worst))
      : "no_expiry_recorded";

    const dated = stocked
      .map((b) => b.expiry_date)
      .filter((d): d is DateOnly => d !== null)
      .sort();

    const total = productTotal(own);
    return {
      product,
      total,
      issuable: issuableTotal(own, today),
      low: isLowStock(total, product.reorder_level),
      batchCount: stocked.length,
      worstStatus,
      earliestExpiry: dated[0] ?? null,
    };
  });
}

export interface DashboardSummary {
  totalProducts: number;
  totalUnits: number;
  issuableUnits: number;
  lowStockCount: number;
  expiredBatches: number;
  expiringSoonBatches: number;
  approachingBatches: number;
  noExpiryBatches: number;
  /** Units locked up in expired batches -- the write-off the clinic is carrying. */
  expiredUnits: number;
}

export function buildDashboardSummary(
  rows: ProductRow[],
  batches: Batch[],
  today: DateOnly,
  bands: ExpiryBands = DEFAULT_EXPIRY_BANDS,
): DashboardSummary {
  const stocked = batches.filter((b) => b.quantity_on_hand > 0);
  const count = (s: ExpiryStatus) =>
    stocked.filter((b) => expiryStatus(b.expiry_date, today, bands) === s).length;

  return {
    // Active products only: a deactivated product should not inflate the count
    // of things the clinic is managing.
    totalProducts: rows.filter((r) => r.product.is_active).length,
    totalUnits: rows.reduce((sum, r) => sum + r.total, 0),
    issuableUnits: rows.reduce((sum, r) => sum + r.issuable, 0),
    lowStockCount: rows.filter((r) => r.low && r.product.is_active).length,
    expiredBatches: count("expired"),
    expiringSoonBatches: count("expiring_soon"),
    approachingBatches: count("approaching_expiry"),
    noExpiryBatches: count("no_expiry_recorded"),
    expiredUnits: stocked
      .filter((b) => isExpired(b.expiry_date, today))
      .reduce((sum, b) => sum + b.quantity_on_hand, 0),
  };
}

/** Case-insensitive search across the fields staff actually type. */
export function matchesSearch(row: ProductRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.product.name.toLowerCase().includes(q) ||
    row.product.sku.toLowerCase().includes(q)
  );
}
