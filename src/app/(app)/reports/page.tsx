"use client";

/**
 * Reports (brief section 4): inventory, low-stock, expiry, movement and
 * adjustment reports with date and category filters.
 *
 * ========================================================================
 * THERE ARE NO EXPORT BUTTONS ON THIS SCREEN YET, AND THAT IS DELIBERATE.
 * ========================================================================
 *
 * CSV and PDF export is milestone 7 (PapaParse and jsPDF). Brief section 14
 * says "no decorative or non-functional buttons", so rather than render a
 * disabled "Export CSV" button that teaches staff to click something that does
 * nothing, the screen states plainly what is coming and when.
 *
 * The data on screen is produced by the same `domain/inventoryView` functions
 * the export will use, so the exported totals cannot disagree with what is
 * displayed here -- which is the §11 acceptance criterion for exports.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { buildProductRows } from "@/domain/inventoryView";
import { expiryStatus } from "@/domain/expiry";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Card, EmptyState, ExpiryBadge, PageHeader, Select, StockBadge,
} from "@/components/ui";

type ReportKind = "inventory" | "low_stock" | "expiry" | "adjustments";

const REPORTS: { value: ReportKind; label: string; description: string }[] = [
  { value: "inventory", label: "Current inventory", description: "Every product with its total, usable stock and reorder level." },
  { value: "low_stock", label: "Low stock", description: "Products at or below their reorder level." },
  { value: "expiry", label: "Expiry", description: "Batches holding stock, ordered by urgency." },
  { value: "adjustments", label: "Adjustments", description: "Count corrections, write-offs and reversals, with reasons." },
];

export default function ReportsPage() {
  return (
    <RequireCapability capability="export_reports">
      <ReportsScreen />
    </RequireCapability>
  );
}

function ReportsScreen() {
  const { today, bands } = useSession();
  const { products, batches, movements, categories, loading, error } = useInventory();
  const [kind, setKind] = useState<ReportKind>("inventory");
  const [category, setCategory] = useState("all");

  const rows = useMemo(
    () => buildProductRows(products, batches, today, bands),
    [products, batches, today, bands],
  );

  const scoped = useMemo(
    () => rows.filter((r) => category === "all" || r.product.category_id === category),
    [rows, category],
  );

  const report = REPORTS.find((r) => r.value === kind)!;

  if (error) return <Alert title="Could not load report data">{error}</Alert>;

  return (
    <>
      <PageHeader title="Reports" description={report.description} />

      <Alert tone="info" title="Export arrives in milestone 7">
        These reports are on-screen only for now. CSV export (PapaParse) and PDF
        export (jsPDF) come next, built on the same figures shown here so the two
        cannot disagree.
      </Alert>

      <Card className="my-4 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="r-kind" className="block text-xs text-muted">Report</label>
            <Select id="r-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
              {REPORTS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="r-category" className="block text-xs text-muted">Category</label>
            <Select id="r-category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-4 text-sm text-muted">Loading report…</p>
        ) : kind === "adjustments" ? (
          <AdjustmentReport
            movements={movements.filter((m) => m.movement_type === "adjustment" || m.movement_type === "reversal")}
            batchLabel={(id) => {
              const b = batches.find((x) => x.id === id);
              const p = b ? products.find((x) => x.id === b.product_id) : undefined;
              return (p ? p.name + " · " : "") + (b?.batch_number ?? "unknown");
            }}
          />
        ) : kind === "expiry" ? (
          <ExpiryReport
            entries={batches
              .filter((b) => b.quantity_on_hand > 0)
              .filter((b) => {
                if (category === "all") return true;
                const p = products.find((x) => x.id === b.product_id);
                return p?.category_id === category;
              })
              .map((b) => ({
                batch: b,
                product: products.find((p) => p.id === b.product_id)?.name ?? "Unknown",
                status: expiryStatus(b.expiry_date, today, bands),
              }))
              .sort((a, b) => (a.batch.expiry_date ?? "9999-12-31").localeCompare(b.batch.expiry_date ?? "9999-12-31"))}
          />
        ) : (
          <InventoryReport rows={kind === "low_stock" ? scoped.filter((r) => r.low) : scoped} lowOnly={kind === "low_stock"} />
        )}
      </Card>
    </>
  );
}

function InventoryReport({ rows, lowOnly }: { rows: ReturnType<typeof buildProductRows>; lowOnly: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title={lowOnly ? "Nothing is low on stock" : "No products match"}>
          {lowOnly ? "Every product in this category is above its reorder level." : "Try another category."}
        </EmptyState>
      </div>
    );
  }
  const totalUnits = rows.reduce((s, r) => s + r.total, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
            <th scope="col" className="px-3 py-2.5 font-medium">SKU</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">On hand</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Usable</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Reorder at</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.product.id} className="border-t border-line">
              <td className="px-3 py-2.5">
                <Link href={"/product?id=" + r.product.id} className="font-medium hover:text-accent hover:underline">
                  {r.product.name}
                </Link>
              </td>
              <td className="tabular px-3 py-2.5 text-muted">{r.product.sku}</td>
              <td className="tabular px-3 py-2.5 text-right font-medium">{r.total}</td>
              <td className="tabular px-3 py-2.5 text-right">{r.issuable}</td>
              <td className="tabular px-3 py-2.5 text-right text-muted">{r.product.reorder_level}</td>
              <td className="px-3 py-2.5"><StockBadge low={r.low} /></td>
            </tr>
          ))}
        </tbody>
        {/* A report without a total is a list. The export must match this
            figure exactly -- that is the §11 acceptance criterion. */}
        <tfoot className="border-t-2 border-line bg-background">
          <tr>
            <td className="px-3 py-2.5 text-xs font-semibold" colSpan={2}>
              {rows.length} {rows.length === 1 ? "product" : "products"}
            </td>
            <td className="tabular px-3 py-2.5 text-right text-xs font-semibold">{totalUnits}</td>
            <td className="tabular px-3 py-2.5 text-right text-xs font-semibold">
              {rows.reduce((s, r) => s + r.issuable, 0)}
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ExpiryReport({
  entries,
}: {
  entries: { batch: { id: string; batch_number: string; quantity_on_hand: number; expiry_date: string | null; product_id: string }; product: string; status: Parameters<typeof ExpiryBadge>[0]["status"] }[];
}) {
  if (entries.length === 0) {
    return <div className="p-4"><EmptyState title="No batches holding stock">Nothing to report.</EmptyState></div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Batch</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">On hand</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Expires</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(({ batch, product, status }) => (
            <tr key={batch.id} className="border-t border-line">
              <td className="px-3 py-2.5">
                <Link href={"/product?id=" + batch.product_id} className="font-medium hover:text-accent hover:underline">
                  {product}
                </Link>
              </td>
              <td className="tabular px-3 py-2.5 text-muted">{batch.batch_number}</td>
              <td className="tabular px-3 py-2.5 text-right">{batch.quantity_on_hand}</td>
              <td className="tabular px-3 py-2.5 text-muted">{batch.expiry_date ?? "—"}</td>
              <td className="px-3 py-2.5"><ExpiryBadge status={status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdjustmentReport({
  movements,
  batchLabel,
}: {
  movements: { id: string; batch_id: string; quantity_delta: number; reason: string | null; notes: string | null; performed_by: string; created_at: string; movement_type: string }[];
  batchLabel: (id: string) => string;
}) {
  if (movements.length === 0) {
    return <div className="p-4"><EmptyState title="No adjustments recorded">Count corrections and write-offs will appear here.</EmptyState></div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2.5 font-medium">When</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Type</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Batch</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Change</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Reason</th>
            <th scope="col" className="px-3 py-2.5 font-medium">By</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id} className="border-t border-line">
              <td className="px-3 py-2.5 whitespace-nowrap text-muted">{m.created_at.slice(0, 10)}</td>
              <td className="px-3 py-2.5 capitalize">{m.movement_type}</td>
              <td className="px-3 py-2.5 text-muted">{batchLabel(m.batch_id)}</td>
              <td className={"tabular px-3 py-2.5 text-right font-medium " + (m.quantity_delta < 0 ? "text-danger" : "text-accent")}>
                {m.quantity_delta > 0 ? "+" : ""}{m.quantity_delta}
              </td>
              <td className="px-3 py-2.5">
                {m.reason ?? "—"}
                {m.notes ? <p className="text-xs text-muted">{m.notes}</p> : null}
              </td>
              <td className="px-3 py-2.5 text-muted">{m.performed_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
