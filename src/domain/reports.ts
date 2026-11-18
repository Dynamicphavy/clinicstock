/**
 * Report models (brief section 4: inventory, low stock, expiry, movement and
 * adjustment reports; section 11: "Correct filtered data and totals are
 * exported").
 *
 * ONE MODEL, THREE RENDERERS.
 *
 * The acceptance criterion is that the exported figures match the source
 * records. The reliable way to satisfy that is not to be careful three times --
 * it is to make disagreement impossible. So each builder below produces a
 * `ReportTable`, and the on-screen table, the CSV and the PDF all render that
 * same object. None of them computes anything.
 *
 * Milestone 4's reports screen built its tables inline in JSX. That worked, but
 * it meant the CSV would have been a second implementation of the same sums --
 * and two implementations of one number eventually disagree. This file is that
 * refactor.
 *
 * Pure: no React, no jsPDF, no PapaParse, no clock. Fully testable.
 */
import type {
  Batch, Category, DateOnly, ExpiryBands, Product, StockMovement,
} from "./types";
import { DEFAULT_EXPIRY_BANDS } from "./types";
import { EXPIRY_STATUS_LABEL, daysToExpiry, expiryStatus } from "./expiry";
import { buildProductRows, type ProductRow } from "./inventoryView";

export type ReportKind =
  | "inventory" | "low_stock" | "expiry" | "movements" | "adjustments";

export interface ReportColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Rendered right-aligned and with tabular figures; summed in totals. */
  numeric?: boolean;
}

export type CellValue = string | number | null;

export interface ReportTable {
  kind: ReportKind;
  title: string;
  /** Clinic, date and the filters in force, for the export header. */
  context: {
    clinicName: string;
    generatedOn: DateOnly;
    filters: string[];
  };
  columns: ReportColumn[];
  rows: Record<string, CellValue>[];
  /** Keyed by column; absent columns render blank in the totals row. */
  totals?: Record<string, CellValue>;
  /** One sentence stating what the figures do and do not include. */
  footnote?: string;
}

export interface ReportFilters {
  categoryId?: string | null;
  /** Inclusive, as YYYY-MM-DD. Movement reports only. */
  from?: string | null;
  to?: string | null;
  productId?: string | null;
}

export interface ReportInput {
  products: Product[];
  batches: Batch[];
  movements: StockMovement[];
  categories: Category[];
  today: DateOnly;
  bands?: ExpiryBands;
  clinicName: string;
  filters?: ReportFilters;
}

/** Human-readable description of the filters, for the export header. */
function describeFilters(input: ReportInput, includeDates: boolean): string[] {
  const f = input.filters ?? {};
  const out: string[] = [];

  const category = f.categoryId
    ? input.categories.find((c) => c.id === f.categoryId)?.name ?? "Unknown category"
    : null;
  out.push("Category: " + (category ?? "All"));

  if (f.productId) {
    const p = input.products.find((x) => x.id === f.productId);
    out.push("Product: " + (p ? p.name + " (" + p.sku + ")" : "Unknown"));
  }

  if (includeDates) {
    // Stated explicitly even when unset. A report that silently covers "all
    // time" and one that covers a chosen month look identical on paper
    // otherwise, and someone will file the wrong one.
    out.push("From: " + (f.from || "the beginning"));
    out.push("To: " + (f.to || input.today));
  }
  return out;
}

function matchesCategory(product: Product | undefined, categoryId?: string | null): boolean {
  if (!categoryId) return true;
  return product?.category_id === categoryId;
}

/* ------------------------------------------------------- inventory reports */

const INVENTORY_COLUMNS: ReportColumn[] = [
  { key: "product", label: "Product" },
  { key: "sku", label: "SKU" },
  { key: "category", label: "Category" },
  { key: "unit", label: "Unit" },
  { key: "on_hand", label: "On hand", numeric: true },
  { key: "usable", label: "Usable", numeric: true },
  { key: "reorder_level", label: "Reorder at", numeric: true },
  { key: "batches", label: "Batches", numeric: true },
  { key: "status", label: "Stock status" },
  { key: "expiry_status", label: "Earliest expiry status" },
];

function inventoryRow(
  row: ProductRow,
  categories: Category[],
): Record<string, CellValue> {
  return {
    product: row.product.name,
    sku: row.product.sku,
    category: categories.find((c) => c.id === row.product.category_id)?.name ?? "",
    unit: row.product.unit,
    on_hand: row.total,
    usable: row.issuable,
    reorder_level: row.product.reorder_level,
    batches: row.batchCount,
    status: row.low ? "Low stock" : "In stock",
    expiry_status: EXPIRY_STATUS_LABEL[row.worstStatus],
  };
}

function inventoryTotals(rows: ProductRow[]): Record<string, CellValue> {
  return {
    product: rows.length + (rows.length === 1 ? " product" : " products"),
    on_hand: rows.reduce((s, r) => s + r.total, 0),
    usable: rows.reduce((s, r) => s + r.issuable, 0),
    batches: rows.reduce((s, r) => s + r.batchCount, 0),
  };
}

export function buildInventoryReport(input: ReportInput): ReportTable {
  const bands = input.bands ?? DEFAULT_EXPIRY_BANDS;
  const rows = buildProductRows(input.products, input.batches, input.today, bands)
    .filter((r) => r.product.is_active)
    .filter((r) => matchesCategory(r.product, input.filters?.categoryId))
    .sort((a, b) => a.product.name.localeCompare(b.product.name));

  return {
    kind: "inventory",
    title: "Current inventory",
    context: {
      clinicName: input.clinicName,
      generatedOn: input.today,
      filters: describeFilters(input, false),
    },
    columns: INVENTORY_COLUMNS,
    rows: rows.map((r) => inventoryRow(r, input.categories)),
    totals: inventoryTotals(rows),
    // The distinction that matters most on a stock report, stated on the
    // report rather than assumed: "on hand" includes expired units.
    footnote:
      "On hand includes expired stock, which remains on the shelf until it is " +
      "written off. Usable excludes it. Inactive products are not listed.",
  };
}

export function buildLowStockReport(input: ReportInput): ReportTable {
  const bands = input.bands ?? DEFAULT_EXPIRY_BANDS;
  const rows = buildProductRows(input.products, input.batches, input.today, bands)
    .filter((r) => r.product.is_active && r.low)
    .filter((r) => matchesCategory(r.product, input.filters?.categoryId))
    .sort((a, b) => a.total - b.total || a.product.name.localeCompare(b.product.name));

  const columns = INVENTORY_COLUMNS.filter((c) => c.key !== "expiry_status").concat({
    key: "shortfall",
    label: "Below reorder by",
    numeric: true,
  });

  return {
    kind: "low_stock",
    title: "Low stock",
    context: {
      clinicName: input.clinicName,
      generatedOn: input.today,
      filters: describeFilters(input, false),
    },
    columns,
    rows: rows.map((r) => ({
      ...inventoryRow(r, input.categories),
      // How much to order to clear the threshold. Zero when sitting exactly on
      // it -- which still counts as low (total <= reorder_level).
      shortfall: Math.max(0, r.product.reorder_level - r.total),
    })),
    totals: {
      ...inventoryTotals(rows),
      shortfall: rows.reduce((s, r) => s + Math.max(0, r.product.reorder_level - r.total), 0),
    },
    footnote:
      "A product is low when its total is at or below its reorder level. " +
      "Sorted by how little is left.",
  };
}

/* ---------------------------------------------------------- expiry report */

export function buildExpiryReport(input: ReportInput): ReportTable {
  const bands = input.bands ?? DEFAULT_EXPIRY_BANDS;
  const productOf = (id: string) => input.products.find((p) => p.id === id);

  const entries = input.batches
    .filter((b) => b.quantity_on_hand > 0)
    .filter((b) => matchesCategory(productOf(b.product_id), input.filters?.categoryId))
    .map((b) => ({
      batch: b,
      product: productOf(b.product_id),
      status: expiryStatus(b.expiry_date, input.today, bands),
      days: daysToExpiry(b.expiry_date, input.today),
    }))
    // Undated last: they cannot be ranked by expiry, and sorting them among
    // dated stock would imply an order that does not exist.
    .sort((a, b) => {
      if (a.batch.expiry_date === null && b.batch.expiry_date === null) {
        return a.batch.received_at.localeCompare(b.batch.received_at);
      }
      if (a.batch.expiry_date === null) return 1;
      if (b.batch.expiry_date === null) return -1;
      return a.batch.expiry_date.localeCompare(b.batch.expiry_date);
    });

  return {
    kind: "expiry",
    title: "Expiry",
    context: {
      clinicName: input.clinicName,
      generatedOn: input.today,
      filters: describeFilters(input, false),
    },
    columns: [
      { key: "product", label: "Product" },
      { key: "sku", label: "SKU" },
      { key: "batch_number", label: "Batch" },
      { key: "quantity", label: "On hand", numeric: true },
      { key: "received_at", label: "Received" },
      { key: "expiry_date", label: "Expires" },
      { key: "days", label: "Days left", numeric: true },
      { key: "status", label: "Status" },
    ],
    rows: entries.map((e) => ({
      product: e.product?.name ?? "Unknown product",
      sku: e.product?.sku ?? "",
      batch_number: e.batch.batch_number,
      quantity: e.batch.quantity_on_hand,
      received_at: e.batch.received_at,
      expiry_date: e.batch.expiry_date,
      // null, not 0 or a dash: a spreadsheet must not read undated stock as
      // "expires today".
      days: e.days,
      status: EXPIRY_STATUS_LABEL[e.status],
    })),
    totals: {
      product: entries.length + (entries.length === 1 ? " batch" : " batches"),
      quantity: entries.reduce((s, e) => s + e.batch.quantity_on_hand, 0),
    },
    footnote:
      "Batches holding stock, earliest expiry first. Undated stock is listed " +
      "last and has no days-left figure, because it cannot be ranked by expiry.",
  };
}

/* -------------------------------------------------------- movement reports */

const MOVEMENT_TYPE_LABEL: Record<StockMovement["movement_type"], string> = {
  receipt: "Received",
  issue: "Issued",
  adjustment: "Adjustment",
  reversal: "Reversal",
};

function buildMovementLike(
  input: ReportInput,
  kind: ReportKind,
  title: string,
  include: (m: StockMovement) => boolean,
  footnote: string,
): ReportTable {
  const f = input.filters ?? {};
  const batchOf = (id: string) => input.batches.find((b) => b.id === id);
  const productOf = (batchId: string) => {
    const b = batchOf(batchId);
    return b ? input.products.find((p) => p.id === b.product_id) : undefined;
  };

  const rows = input.movements
    .filter(include)
    .filter((m) => {
      // created_at is an ISO instant; its first 10 characters are the calendar
      // date, which is what a user means by a date filter.
      const day = m.created_at.slice(0, 10);
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
      return true;
    })
    .filter((m) => matchesCategory(productOf(m.batch_id), f.categoryId))
    .filter((m) => !f.productId || batchOf(m.batch_id)?.product_id === f.productId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const received = rows.filter((m) => m.quantity_delta > 0).reduce((s, m) => s + m.quantity_delta, 0);
  const removed = rows.filter((m) => m.quantity_delta < 0).reduce((s, m) => s + m.quantity_delta, 0);

  return {
    kind,
    title,
    context: {
      clinicName: input.clinicName,
      generatedOn: input.today,
      filters: describeFilters(input, true),
    },
    columns: [
      { key: "date", label: "Date" },
      { key: "time", label: "Time" },
      { key: "type", label: "Type" },
      { key: "product", label: "Product" },
      { key: "sku", label: "SKU" },
      { key: "batch_number", label: "Batch" },
      { key: "change", label: "Change", numeric: true },
      { key: "reason", label: "Reason" },
      { key: "notes", label: "Notes" },
      { key: "performed_by", label: "Performed by" },
    ],
    rows: rows.map((m) => {
      const product = productOf(m.batch_id);
      return {
        // Date and time split into separate columns: a spreadsheet can then
        // group by day without parsing a timestamp, which is the first thing
        // anyone does with a movement export.
        date: m.created_at.slice(0, 10),
        time: m.created_at.slice(11, 16),
        type: MOVEMENT_TYPE_LABEL[m.movement_type],
        product: product?.name ?? "Unknown product",
        sku: product?.sku ?? "",
        batch_number: batchOf(m.batch_id)?.batch_number ?? "",
        change: m.quantity_delta,
        reason: m.reason ?? "",
        notes: m.notes ?? "",
        performed_by: m.performed_by,
      };
    }),
    totals: {
      date: rows.length + (rows.length === 1 ? " movement" : " movements"),
      // Net is the sum; in and out are shown separately because a net of zero
      // can mean "nothing happened" or "100 in, 100 out", and a stock report
      // must distinguish those.
      change: received + removed,
      reason: "In +" + received + " / Out " + removed,
    },
    footnote,
  };
}

export function buildMovementReport(input: ReportInput): ReportTable {
  return buildMovementLike(
    input, "movements", "Stock movements",
    () => true,
    "Every stock movement in the period, newest first. History is append-only: " +
      "a correction appears as a reversal alongside the movement it corrects, " +
      "never as an edit.",
  );
}

export function buildAdjustmentReport(input: ReportInput): ReportTable {
  return buildMovementLike(
    input, "adjustments", "Adjustments and reversals",
    (m) => m.movement_type === "adjustment" || m.movement_type === "reversal",
    "Count corrections, damage, loss, write-offs and reversals. Every row " +
      "carries a mandatory reason and the person who recorded it.",
  );
}

/* -------------------------------------------------------------- dispatcher */

export const REPORT_KINDS: { kind: ReportKind; label: string; description: string; dated: boolean }[] = [
  { kind: "inventory", label: "Current inventory", description: "Every active product with its totals and reorder level.", dated: false },
  { kind: "low_stock", label: "Low stock", description: "Products at or below their reorder level, and how far below.", dated: false },
  { kind: "expiry", label: "Expiry", description: "Batches holding stock, earliest expiry first.", dated: false },
  { kind: "movements", label: "Stock movements", description: "Receipts, issues, adjustments and reversals.", dated: true },
  { kind: "adjustments", label: "Adjustments", description: "Corrections and write-offs, with reasons.", dated: true },
];

export function buildReport(kind: ReportKind, input: ReportInput): ReportTable {
  switch (kind) {
    case "inventory": return buildInventoryReport(input);
    case "low_stock": return buildLowStockReport(input);
    case "expiry": return buildExpiryReport(input);
    case "movements": return buildMovementReport(input);
    case "adjustments": return buildAdjustmentReport(input);
  }
}

/**
 * A filename that sorts chronologically and says what it contains.
 *
 * "report.csv" in a downloads folder beside eleven other "report.csv" files is
 * how a clinic loses track of which month it was looking at.
 */
export function reportFilename(table: ReportTable, extension: "csv" | "pdf"): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return [slug(table.context.clinicName), slug(table.title), table.context.generatedOn]
    .filter(Boolean)
    .join("_") + "." + extension;
}
