/**
 * Report and export tests.
 *
 * Brief section 11: "CSV/PDF export -> Correct filtered data and totals are
 * exported."
 *
 * The important assertions here are the ones that compare the EXPORT against
 * the SOURCE, not against a hard-coded expected string. A test that says
 * "the total is 140" passes a report that sums the wrong column if 140 happens
 * to be right; a test that says "the total equals the sum of the batches"
 * cannot.
 */
import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import type { Batch, Category, Product, StockMovement } from "@/domain/types";
import { addDays } from "@/domain/dateOnly";
import { productTotal } from "@/domain/stock";
import {
  buildAdjustmentReport, buildExpiryReport, buildInventoryReport,
  buildLowStockReport, buildMovementReport, buildReport, reportFilename,
  type ReportInput,
} from "@/domain/reports";
import { reportToCsv } from "@/lib/export/csv";

const TODAY = "2026-11-18";

const categories: Category[] = [
  { id: "cat-med", organization_id: "org", name: "Medicines", description: null },
  { id: "cat-con", organization_id: "org", name: "Consumables", description: null },
];

function product(over: Partial<Product> & { id: string }): Product {
  return {
    organization_id: "org", category_id: "cat-med", name: "Test", sku: "TST-1",
    unit: "box", reorder_level: 10, description: null, is_active: true,
    created_at: "2026-01-01T00:00:00.000Z", ...over,
  };
}

function batch(over: Partial<Batch> & { id: string; product_id: string }): Batch {
  return {
    organization_id: "org", supplier_id: null, batch_number: over.id.toUpperCase(),
    quantity_on_hand: 10, unit_cost: null, received_at: addDays(TODAY, -30),
    expiry_date: addDays(TODAY, 120), created_at: "2026-01-01T00:00:00.000Z", ...over,
  };
}

function movement(over: Partial<StockMovement> & { id: string; batch_id: string }): StockMovement {
  return {
    organization_id: "org", movement_type: "issue", quantity_delta: -5,
    reason: "Ward usage", notes: null, performed_by: "user-1",
    created_at: "2026-11-10T09:30:00.000Z", reverses_movement_id: null, ...over,
  };
}

const products: Product[] = [
  product({ id: "p1", name: "Paracetamol 500mg", sku: "MED-001", reorder_level: 100, unit: "tablet" }),
  product({ id: "p2", name: "Gauze swabs", sku: "CON-002", category_id: "cat-con", reorder_level: 40, unit: "pack" }),
  product({ id: "p3", name: "Retired item", sku: "OLD-001", is_active: false }),
];

const batches: Batch[] = [
  batch({ id: "b1", product_id: "p1", quantity_on_hand: 60, expiry_date: addDays(TODAY, 20) }),
  batch({ id: "b2", product_id: "p1", quantity_on_hand: 80, expiry_date: addDays(TODAY, 300) }),
  batch({ id: "b3", product_id: "p2", quantity_on_hand: 25, expiry_date: addDays(TODAY, 45) }),
  batch({ id: "b4", product_id: "p2", quantity_on_hand: 40, expiry_date: addDays(TODAY, -2) }),
  batch({ id: "b5", product_id: "p1", quantity_on_hand: 15, expiry_date: null }),
];

const movements: StockMovement[] = [
  movement({ id: "m1", batch_id: "b1", movement_type: "receipt", quantity_delta: 60, reason: "Opening", created_at: "2026-10-01T08:00:00.000Z" }),
  movement({ id: "m2", batch_id: "b3", movement_type: "issue", quantity_delta: -5, created_at: "2026-11-10T09:30:00.000Z" }),
  movement({ id: "m3", batch_id: "b3", movement_type: "adjustment", quantity_delta: -2, reason: "Damaged in storage", created_at: "2026-11-15T14:00:00.000Z" }),
  movement({ id: "m4", batch_id: "b1", movement_type: "reversal", quantity_delta: 5, reason: "Wrong batch", reverses_movement_id: "m2", created_at: "2026-11-16T10:00:00.000Z" }),
];

const input: ReportInput = {
  products, batches, movements, categories,
  today: TODAY, clinicName: "Riverside Clinic",
};

/** Parses a generated CSV back into a matrix, so tests read what a clinic gets. */
function parseCsv(csv: string): string[][] {
  // Strip the UTF-8 BOM before parsing, exactly as a spreadsheet would.
  return Papa.parse<string[]>(csv.replace(/^﻿/, ""), { skipEmptyLines: false }).data;
}

describe("inventory report", () => {
  it("totals equal the sum of the source batches", () => {
    // The acceptance criterion, asserted against the source rather than a
    // hard-coded number.
    const table = buildInventoryReport(input);
    const expected = products
      .filter((p) => p.is_active)
      .reduce((sum, p) => sum + productTotal(batches.filter((b) => b.product_id === p.id)), 0);
    expect(table.totals?.on_hand).toBe(expected);
  });

  it("excludes inactive products", () => {
    const table = buildInventoryReport(input);
    expect(table.rows.map((r) => r.sku)).not.toContain("OLD-001");
    expect(table.rows).toHaveLength(2);
  });

  it("reports on-hand and usable separately when stock has expired", () => {
    const table = buildInventoryReport(input);
    const gauze = table.rows.find((r) => r.sku === "CON-002")!;
    expect(gauze.on_hand).toBe(65); // 25 in date + 40 expired
    expect(gauze.usable).toBe(25);
  });

  it("filters by category, and the totals follow the filter", () => {
    const filtered = buildInventoryReport({ ...input, filters: { categoryId: "cat-con" } });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.totals?.on_hand).toBe(65);
    // The filter must be stated on the report, not just applied to it.
    expect(filtered.context.filters.join(" ")).toContain("Consumables");
  });
});

describe("low stock report", () => {
  it("lists only products at or below the reorder level", () => {
    const table = buildLowStockReport(input);
    // Paracetamol: 155 vs 100 -> fine. Gauze: 65 vs 40 -> fine. So none.
    expect(table.rows).toHaveLength(0);
  });

  it("includes a product sitting exactly ON its reorder level", () => {
    // The <= boundary again, this time through the reporting path.
    const table = buildLowStockReport({
      ...input,
      products: [product({ id: "p1", name: "Exact", sku: "EX-1", reorder_level: 10 })],
      batches: [batch({ id: "b1", product_id: "p1", quantity_on_hand: 10 })],
    });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].shortfall).toBe(0);
  });

  it("reports how far below the threshold each product is", () => {
    const table = buildLowStockReport({
      ...input,
      products: [product({ id: "p1", name: "Short", sku: "SH-1", reorder_level: 50 })],
      batches: [batch({ id: "b1", product_id: "p1", quantity_on_hand: 12 })],
    });
    expect(table.rows[0].shortfall).toBe(38);
    expect(table.totals?.shortfall).toBe(38);
  });
});

describe("expiry report", () => {
  it("orders by expiry date and puts undated stock last", () => {
    const table = buildExpiryReport(input);
    const order = table.rows.map((r) => r.batch_number);
    expect(order[0]).toBe("B4");               // expired two days ago
    expect(order[order.length - 1]).toBe("B5"); // no expiry date
  });

  it("leaves days-left NULL for undated stock, never 0", () => {
    // A spreadsheet must not read undated stock as "expires today".
    const table = buildExpiryReport(input);
    const undated = table.rows.find((r) => r.batch_number === "B5")!;
    expect(undated.days).toBeNull();
    expect(undated.expiry_date).toBeNull();
  });

  it("excludes empty batches", () => {
    const table = buildExpiryReport({
      ...input,
      batches: [...batches, batch({ id: "b9", product_id: "p1", quantity_on_hand: 0 })],
    });
    expect(table.rows.map((r) => r.batch_number)).not.toContain("B9");
  });

  it("totals the quantity actually listed", () => {
    const table = buildExpiryReport(input);
    const listed = table.rows.reduce((s, r) => s + (r.quantity as number), 0);
    expect(table.totals?.quantity).toBe(listed);
  });
});

describe("movement report", () => {
  it("is newest first", () => {
    const table = buildMovementReport(input);
    const dates = table.rows.map((r) => String(r.date) + String(r.time));
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("filters by date range, inclusively at both ends", () => {
    const table = buildMovementReport({
      ...input,
      filters: { from: "2026-11-10", to: "2026-11-15" },
    });
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.date)).toEqual(["2026-11-15", "2026-11-10"]);
  });

  it("separates stock in from stock out rather than only netting them", () => {
    // A net of zero can mean "nothing happened" or "100 in, 100 out". A stock
    // report has to distinguish those.
    const table = buildMovementReport(input);
    expect(table.totals?.change).toBe(60 - 5 - 2 + 5);
    expect(String(table.totals?.reason)).toBe("In +65 / Out -7");
  });

  it("filters by product through the batch", () => {
    const table = buildMovementReport({ ...input, filters: { productId: "p2" } });
    expect(table.rows).toHaveLength(2);
    expect(table.rows.every((r) => r.sku === "CON-002")).toBe(true);
  });
});

describe("adjustment report", () => {
  it("includes adjustments and reversals, and nothing else", () => {
    const table = buildAdjustmentReport(input);
    expect(table.rows.map((r) => r.type).sort()).toEqual(["Adjustment", "Reversal"]);
  });

  it("carries the reason and the actor for every row", () => {
    const table = buildAdjustmentReport(input);
    for (const row of table.rows) {
      expect(String(row.reason).length).toBeGreaterThan(0);
      expect(String(row.performed_by).length).toBeGreaterThan(0);
    }
  });
});

describe("CSV export", () => {
  it("contains exactly the rows and totals shown on screen", () => {
    // The strongest form of the section 11 criterion: the file is derived from
    // the same object the screen renders, and this proves the serialisation
    // did not drop or reorder anything.
    const table = buildInventoryReport(input);
    const matrix = parseCsv(reportToCsv(table));

    const headerIndex = matrix.findIndex((r) => r[0] === "Product");
    expect(headerIndex).toBeGreaterThan(-1);
    expect(matrix[headerIndex]).toEqual(table.columns.map((c) => c.label));

    const dataRows = matrix.slice(headerIndex + 1).filter((r) => r.length > 1 && r[0] !== "");
    // Last non-empty row is the totals row.
    const totalsRow = dataRows[dataRows.length - 1];
    const bodyRows = dataRows.slice(0, -1);

    expect(bodyRows).toHaveLength(table.rows.length);
    bodyRows.forEach((csvRow, i) => {
      table.columns.forEach((col, j) => {
        const expected = table.rows[i][col.key];
        expect(csvRow[j]).toBe(expected === null ? "" : String(expected));
      });
    });

    const onHandIndex = table.columns.findIndex((c) => c.key === "on_hand");
    expect(totalsRow[onHandIndex]).toBe(String(table.totals?.on_hand));
  });

  it("escapes commas and quotes instead of corrupting the columns", () => {
    // The reason PapaParse is used rather than rows.join(","). A product named
    // 'Gauze, 10cm "sterile"' would otherwise shift every later column by one.
    const table = buildInventoryReport({
      ...input,
      products: [product({ id: "p1", name: 'Gauze, 10cm "sterile"', sku: "CON-010" })],
      batches: [batch({ id: "b1", product_id: "p1", quantity_on_hand: 7 })],
    });
    const matrix = parseCsv(reportToCsv(table));
    const header = matrix.findIndex((r) => r[0] === "Product");
    expect(matrix[header + 1][0]).toBe('Gauze, 10cm "sterile"');
    expect(matrix[header + 1][1]).toBe("CON-010");
    expect(Number(matrix[header + 1][4])).toBe(7);
  });

  it("starts with a UTF-8 BOM so Excel reads non-ASCII correctly", () => {
    expect(reportToCsv(buildInventoryReport(input)).startsWith("﻿")).toBe(true);
  });

  it("records the clinic, the date and the filters in the file itself", () => {
    // An export outlives the screen it came from.
    const csv = reportToCsv(buildMovementReport({
      ...input, filters: { from: "2026-11-01", to: "2026-11-30", categoryId: "cat-con" },
    }));
    expect(csv).toContain("Riverside Clinic");
    expect(csv).toContain(TODAY);
    expect(csv).toContain("2026-11-01");
    expect(csv).toContain("Consumables");
  });

  it("writes an empty cell for null, not the text 'null'", () => {
    const csv = reportToCsv(buildExpiryReport(input));
    expect(csv).not.toContain("null");
  });

  it("can omit the context block for a machine-readable file", () => {
    const table = buildInventoryReport(input);
    const matrix = parseCsv(reportToCsv(table, { includeContext: false }));
    expect(matrix[0]).toEqual(table.columns.map((c) => c.label));
  });
});

describe("filenames", () => {
  it("names the clinic, the report and the date", () => {
    const name = reportFilename(buildInventoryReport(input), "csv");
    expect(name).toBe("riverside-clinic_current-inventory_2026-11-18.csv");
  });

  it("produces a safe filename from an awkward clinic name", () => {
    const table = buildInventoryReport({ ...input, clinicName: "St. Mary's / Ikeja (Annexe)" });
    const name = reportFilename(table, "pdf");
    expect(name).toMatch(/^[a-z0-9_.-]+\.pdf$/);
  });
});

describe("every report kind", () => {
  it("builds without throwing and states its filters", () => {
    for (const kind of ["inventory", "low_stock", "expiry", "movements", "adjustments"] as const) {
      const table = buildReport(kind, input);
      expect(table.kind).toBe(kind);
      expect(table.columns.length).toBeGreaterThan(0);
      expect(table.context.clinicName).toBe("Riverside Clinic");
      expect(table.context.filters.length).toBeGreaterThan(0);
    }
  });

  it("survives a clinic with no data at all", () => {
    // A brand-new clinic opens this screen before adding anything.
    const emptyInput: ReportInput = {
      products: [], batches: [], movements: [], categories: [],
      today: TODAY, clinicName: "New Clinic",
    };
    for (const kind of ["inventory", "low_stock", "expiry", "movements", "adjustments"] as const) {
      const table = buildReport(kind, emptyInput);
      expect(table.rows).toEqual([]);
      expect(() => reportToCsv(table)).not.toThrow();
    }
  });
});

describe("PDF export", () => {
  /**
   * jsPDF runs in Node, so the real bytes can be asserted rather than trusting
   * that the function "probably works". These are smoke tests, not a layout
   * check -- proving a column is 3mm from the margin is not worth the cost, but
   * proving the file is a valid, non-empty, correctly paginated PDF is.
   */
  it("produces a valid, non-trivial PDF", async () => {
    const { reportToPdf } = await import("@/lib/export/pdf");
    const bytes = reportToPdf(buildInventoryReport(input)).output("arraybuffer");
    const head = Buffer.from(bytes.slice(0, 5)).toString("latin1");
    expect(head).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("paginates a long report instead of writing off the page", async () => {
    const { reportToPdf } = await import("@/lib/export/pdf");
    const many = Array.from({ length: 200 }, (_, i) =>
      batch({ id: "b" + i, product_id: "p1", batch_number: "BATCH-" + i, quantity_on_hand: i + 1 }),
    );
    const doc = reportToPdf(buildExpiryReport({ ...input, batches: many }));
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });

  it("renders an empty report without throwing", async () => {
    const { reportToPdf } = await import("@/lib/export/pdf");
    const table = buildLowStockReport(input); // no low-stock products in the fixture
    expect(table.rows).toHaveLength(0);
    expect(() => reportToPdf(table)).not.toThrow();
  });

  it("survives a product name far wider than its column", async () => {
    // Truncation is the behaviour under test: text overflowing a cell would
    // overlap the next column and make the figures unreadable.
    const { reportToPdf } = await import("@/lib/export/pdf");
    const table = buildInventoryReport({
      ...input,
      products: [product({ id: "p1", name: "X".repeat(400), sku: "LONG-1" })],
      batches: [batch({ id: "b1", product_id: "p1", quantity_on_hand: 5 })],
    });
    const bytes = reportToPdf(table).output("arraybuffer");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
