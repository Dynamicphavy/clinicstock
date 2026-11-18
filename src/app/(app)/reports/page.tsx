"use client";

/**
 * Reports (brief section 4): inventory, low-stock, expiry, movement and
 * adjustment reports; date and category filters; CSV and PDF export.
 *
 * THE SCREEN COMPUTES NOTHING.
 *
 * It asks `buildReport()` for a ReportTable and renders it. The CSV and the PDF
 * render the same object. That is how section 11's "correct filtered data and
 * totals are exported" is satisfied structurally: there is one set of figures,
 * so the export cannot disagree with the screen.
 *
 * Milestone 4's version built its tables inline in JSX, which would have forced
 * the exporters to re-derive every sum -- and two implementations of one number
 * eventually disagree.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Download, FileText } from "lucide-react";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import {
  REPORT_KINDS, buildReport, reportFilename,
  type ReportKind, type ReportTable,
} from "@/domain/reports";
import { downloadCsv } from "@/lib/export/csv";
import { downloadPdf } from "@/lib/export/pdf";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Button, Card, EmptyState, PageHeader, Select, TextInput,
} from "@/components/ui";

export default function ReportsPage() {
  return (
    <RequireCapability capability="export_reports">
      <ReportsScreen />
    </RequireCapability>
  );
}

function ReportsScreen() {
  const { today, bands, clinicName } = useSession();
  const { products, batches, movements, categories, loading, error } = useInventory();

  const [kind, setKind] = useState<ReportKind>("inventory");
  const [categoryId, setCategoryId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const meta = REPORT_KINDS.find((r) => r.kind === kind)!;

  const table: ReportTable = useMemo(
    () =>
      buildReport(kind, {
        products, batches, movements, categories,
        today, bands, clinicName,
        filters: {
          categoryId: categoryId || null,
          productId: productId || null,
          from: from || null,
          to: to || null,
        },
      }),
    [kind, products, batches, movements, categories, today, bands, clinicName, categoryId, productId, from, to],
  );

  /**
   * Export is synchronous but can take a moment on a few thousand rows, and
   * jsPDF can throw (out of memory on a very large table). Catching it means a
   * failed export says so rather than appearing to do nothing -- the same
   * "never show a false success" rule as the stock forms.
   */
  const runExport = (format: "csv" | "pdf") => {
    setExportError(null);
    setExporting(format);
    try {
      const filename = reportFilename(table, format);
      if (format === "csv") downloadCsv(table, filename);
      else downloadPdf(table, filename);
    } catch (e) {
      setExportError(
        "Could not generate the " + format.toUpperCase() + " file" +
        (e instanceof Error ? ": " + e.message : "") +
        ". Try narrowing the filters.",
      );
    } finally {
      setExporting(null);
    }
  };

  if (error) return <Alert title="Could not load report data">{error}</Alert>;

  const empty = table.rows.length === 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description={meta.description}
        actions={
          <>
            {/* Disabled while loading or empty: exporting nothing produces a
                file with a header and no rows, which looks like data loss. */}
            <Button
              variant="secondary"
              onClick={() => runExport("csv")}
              disabled={loading || empty}
              pending={exporting === "csv"}
              pendingLabel="Preparing…"
            >
              <Download size={15} aria-hidden /> Export CSV
            </Button>
            <Button
              onClick={() => runExport("pdf")}
              disabled={loading || empty}
              pending={exporting === "pdf"}
              pendingLabel="Preparing…"
            >
              <FileText size={15} aria-hidden /> Export PDF
            </Button>
          </>
        }
      />

      {exportError ? <div className="mb-4"><Alert title="Export failed">{exportError}</Alert></div> : null}

      <Card className="mb-4 p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="r-kind" className="block text-xs text-muted">Report</label>
            <Select id="r-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
              {REPORT_KINDS.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
            </Select>
          </div>

          <div>
            <label htmlFor="r-category" className="block text-xs text-muted">Category</label>
            <Select id="r-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>

          <div>
            <label htmlFor="r-product" className="block text-xs text-muted">Product</label>
            <Select id="r-product" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">All products</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
            </Select>
          </div>

          {/* Date filters appear only for the reports they apply to. A date
              range on a current-inventory snapshot would be a control that
              silently does nothing. */}
          {meta.dated ? (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="r-from" className="block text-xs text-muted">From</label>
                <TextInput id="r-from" type="date" value={from} max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="r-to" className="block text-xs text-muted">To</label>
                <TextInput id="r-to" type="date" value={to} min={from || undefined}
                  onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="flex items-end">
              <p className="text-xs text-muted">
                This report is a snapshot of today, {today}.
              </p>
            </div>
          )}
        </div>

        <p className="mt-3 border-t border-line pt-2.5 text-xs text-muted">
          {table.context.filters.join("  ·  ")}
        </p>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-4 text-sm text-muted">Loading report…</p>
        ) : empty ? (
          <div className="p-4">
            <EmptyState title="No records match these filters">
              {kind === "low_stock"
                ? "Every active product is above its reorder level."
                : "Try a wider date range, or clear the category and product filters."}
            </EmptyState>
          </div>
        ) : (
          <ReportGrid table={table} />
        )}
      </Card>

      {table.footnote ? (
        <p className="mt-3 max-w-3xl text-xs text-muted">{table.footnote}</p>
      ) : null}
    </>
  );
}

/** Renders any ReportTable. One component for all five reports. */
function ReportGrid({ table }: { table: ReportTable }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          {table.title} for {table.context.clinicName}, generated {table.context.generatedOn}
        </caption>
        <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col"
                className={"px-3 py-2.5 font-medium whitespace-nowrap " + (c.numeric ? "text-right" : "")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="border-t border-line">
              {table.columns.map((c) => {
                const v = row[c.key];
                return (
                  <td key={c.key}
                    className={
                      "px-3 py-2.5 " +
                      (c.numeric ? "tabular text-right " : "") +
                      // Negative changes in red, matching the movement list.
                      (c.key === "change" && typeof v === "number" && v < 0 ? "text-danger " : "") +
                      (c.key === "change" && typeof v === "number" && v > 0 ? "text-accent " : "")
                    }
                  >
                    {v === null || v === "" ? <span className="text-muted">—</span>
                      : c.key === "change" && typeof v === "number" && v > 0 ? "+" + v
                      : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {table.totals ? (
          <tfoot className="border-t-2 border-line bg-background">
            <tr>
              {table.columns.map((c) => (
                <td key={c.key}
                  className={"px-3 py-2.5 text-xs font-semibold " + (c.numeric ? "tabular text-right" : "")}>
                  {table.totals![c.key] ?? ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
      <p className="border-t border-line px-3 py-2 text-xs text-muted">
        <Link href="/inventory" className="text-accent hover:underline">Inventory</Link>
        {" · "}These figures are what the CSV and PDF exports contain, unchanged.
      </p>
    </div>
  );
}
