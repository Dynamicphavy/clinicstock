"use client";

/**
 * Product details (brief section 4): summary, total stock, batch breakdown,
 * expiry dates and recent movement history.
 *
 * ========================================================================
 * WHY THE URL IS `/product?id=X` AND NOT `/product/[id]`
 * ========================================================================
 *
 * A dynamic route is the obvious design, and it does not work here.
 *
 * `output: "export"` renders every page to a static HTML file at BUILD time.
 * For `/product/[id]` Next.js must know every id in advance, via
 * `generateStaticParams()`. Our products live in the visitor's localStorage --
 * and later in a per-clinic database behind authentication. There is no build
 * step on earth that can enumerate them.
 *
 * So the id travels as a query string, which is read in the browser at runtime.
 * One static `/product/index.html` serves every product.
 *
 * This is exactly the trade-off brief section 5 warns about: "server actions,
 * server-side routes and other server-dependent Next.js features are not
 * available in a pure static export". Note what we did NOT do -- we did not
 * reach for a server runtime, and we did not leak a key to fake one. We changed
 * the URL shape.
 */

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDownToLine, ArrowUpFromLine, Pencil, SlidersHorizontal } from "lucide-react";
import { useSession } from "@/app/providers";
import { useProduct } from "@/hooks/useInventory";
import { daysToExpiry, expiryStatus } from "@/domain/expiry";
import { productTotal, issuableTotal, recommendFefoBatch } from "@/domain/stock";
import { isLowStock } from "@/domain/stock";
import { can } from "@/domain/permissions";
import {
  Alert, Button, Card, EmptyState, ExpiryBadge, PageHeader, StatCard, StockBadge,
} from "@/components/ui";
import { MovementList } from "@/components/inventory/MovementList";

export default function ProductDetailsPage() {
  /**
   * `useSearchParams` suspends during the static prerender, because the query
   * string only exists in the browser. Without this boundary the build fails
   * with a missing-suspense error -- another constraint that is cheap to meet
   * now and expensive to discover in milestone 8.
   */
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading product…</p>}>
      <ProductDetails />
    </Suspense>
  );
}

function ProductDetails() {
  const params = useSearchParams();
  const id = params.get("id");
  const { today, bands, role } = useSession();
  const { product, batches, movements, loading, error } = useProduct(id);

  const fefo = useMemo(() => recommendFefoBatch(batches, today), [batches, today]);

  if (!id) {
    return (
      <Alert title="No product selected">
        Open a product from the <Link href="/inventory" className="underline">inventory list</Link>.
      </Alert>
    );
  }
  if (error) return <Alert title="Could not load this product">{error}</Alert>;
  if (loading) return <p className="text-sm text-muted">Loading product…</p>;
  if (!product) {
    return (
      <Alert title="Product not found">
        This product may have been removed, or the demo data was reset.{" "}
        <Link href="/inventory" className="underline">Back to inventory</Link>.
      </Alert>
    );
  }

  const total = productTotal(batches);
  const usable = issuableTotal(batches, today);
  const low = isLowStock(total, product.reorder_level);
  const canMove = can(role, "move_stock");
  const canEdit = can(role, "manage_products");
  const sorted = [...batches].sort((a, b) => {
    // Undated batches last: they cannot be ranked by expiry, so pretending an
    // order exists would be a lie the sort tells silently.
    if (a.expiry_date === null && b.expiry_date === null) return a.received_at.localeCompare(b.received_at);
    if (a.expiry_date === null) return 1;
    if (b.expiry_date === null) return -1;
    return a.expiry_date.localeCompare(b.expiry_date);
  });

  return (
    <>
      <PageHeader
        title={product.name}
        description={product.sku + " · counted in " + product.unit + (product.is_active ? "" : " · inactive")}
        actions={
          <>
            {canEdit ? (
              <Link href={"/product/edit?id=" + product.id}>
                <Button variant="secondary"><Pencil size={15} aria-hidden /> Edit</Button>
              </Link>
            ) : null}
            {canMove ? (
              <>
                <Link href={"/receive?product=" + product.id}>
                  <Button variant="secondary"><ArrowDownToLine size={15} aria-hidden /> Receive</Button>
                </Link>
                <Link href={"/issue?product=" + product.id}>
                  <Button><ArrowUpFromLine size={15} aria-hidden /> Record usage</Button>
                </Link>
              </>
            ) : null}
          </>
        }
      />

      {product.description ? (
        <p className="mb-5 max-w-2xl text-sm text-muted">{product.description}</p>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total on hand" value={total} sub={product.unit} />
        <StatCard
          label="Usable today"
          value={usable}
          sub={usable === total ? "all stock in date" : total - usable + " expired"}
          tone={usable === total ? "neutral" : "warn"}
        />
        <StatCard label="Reorder level" value={product.reorder_level} sub={low ? "at or below" : "above threshold"} tone={low ? "warn" : "neutral"} />
        <StatCard label="Batches holding stock" value={sorted.filter((b) => b.quantity_on_hand > 0).length} />
      </div>

      {low ? (
        <div className="mb-5">
          <Alert tone="warn" title="Low stock">
            {total} {product.unit} on hand, at or below the reorder level of {product.reorder_level}.
          </Alert>
        </div>
      ) : null}

      <Card className="mb-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Batches</h2>
          <StockBadge low={low} />
        </div>

        {sorted.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No batches yet"
              action={canMove ? (
                <Link href={"/receive?product=" + product.id}><Button>Receive the first batch</Button></Link>
              ) : undefined}
            >
              Stock is tracked per batch, so each delivery keeps its own expiry date.
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Batches for this product, earliest expiry first</caption>
              <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Batch</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">On hand</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Received</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Expires</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => {
                  const status = expiryStatus(b.expiry_date, today, bands);
                  const days = daysToExpiry(b.expiry_date, today);
                  const isFefo = fefo?.batch.id === b.id;
                  return (
                    <tr key={b.id} className="border-t border-line">
                      <td className="tabular px-3 py-2.5 font-medium">
                        {b.batch_number}
                        {/* The FEFO hint is on the row it concerns, and it names
                            its basis -- "earliest expiry" vs "oldest receipt" --
                            so staff are never told undated stock was ranked by
                            expiry. */}
                        {isFefo ? (
                          <p className="text-xs font-normal text-accent">
                            Use first ({fefo.basis === "expiry" ? "earliest expiry" : "oldest receipt"})
                          </p>
                        ) : null}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">{b.quantity_on_hand}</td>
                      <td className="tabular px-3 py-2.5 text-muted">{b.received_at}</td>
                      <td className="tabular px-3 py-2.5 text-muted">
                        {b.expiry_date ?? "—"}
                        {days !== null ? (
                          <p className="text-xs">
                            {days < 0 ? Math.abs(days) + " days ago" : days === 0 ? "today" : "in " + days + " days"}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5"><ExpiryBadge status={status} /></td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {canMove ? (
                          <Link href={"/adjust?batch=" + b.id} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                            <SlidersHorizontal size={13} aria-hidden /> Adjust
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Movement history</h2>
          <p className="text-xs text-muted">Append-only. Corrections appear as reversals, never as edits.</p>
        </div>
        <MovementList
          movements={movements}
          batchLabel={(batchId) => batches.find((b) => b.id === batchId)?.batch_number ?? "unknown"}
          emptyHint="Receipts, usage and adjustments for this product will appear here."
        />
      </Card>
    </>
  );
}
