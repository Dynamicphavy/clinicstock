"use client";

/**
 * Dashboard (brief section 4): total products, total units, low-stock products,
 * expiring batches, expired batches, recent movements and quick actions.
 *
 * Built LAST of the data screens, on purpose (see the build sequence in
 * docs/ARCHITECTURE.md). It is the most satisfying screen to build and the
 * least useful to build early -- every number on it is produced by a screen
 * that already works, so building it first means inventing numbers you cannot
 * yet verify.
 *
 * NO CHART HERE, deliberately. The brief lists Recharts as an available tool,
 * but a bar chart of five products carries less information than the table
 * underneath it and takes more space. A chart earns its place when the data has
 * a shape worth seeing -- stock movement over months, say, which is a milestone
 * 7 reporting concern.
 */

import { useMemo } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, Package, Plus } from "lucide-react";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { buildDashboardSummary, buildProductRows } from "@/domain/inventoryView";
import { expiryStatus } from "@/domain/expiry";
import { can } from "@/domain/permissions";
import {
  Alert, Button, Card, EmptyState, ExpiryBadge, PageHeader, StatCard,
} from "@/components/ui";
import { MovementList } from "@/components/inventory/MovementList";

export default function DashboardPage() {
  const { today, bands, role, clinicName } = useSession();
  const { products, batches, movements, loading, error } = useInventory();

  const rows = useMemo(
    () => buildProductRows(products, batches, today, bands),
    [products, batches, today, bands],
  );
  const summary = useMemo(
    () => buildDashboardSummary(rows, batches, today, bands),
    [rows, batches, today, bands],
  );

  const lowStock = rows.filter((r) => r.low && r.product.is_active);
  const attention = useMemo(
    () =>
      batches
        .filter((b) => b.quantity_on_hand > 0)
        .map((b) => ({ batch: b, status: expiryStatus(b.expiry_date, today, bands) }))
        .filter((x) => x.status === "expired" || x.status === "expiring_soon")
        // Expired first, then soonest expiry: the order someone should act in.
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "expired" ? -1 : 1;
          return (a.batch.expiry_date ?? "").localeCompare(b.batch.expiry_date ?? "");
        }),
    [batches, today, bands],
  );

  const canMove = can(role, "move_stock");
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? "Unknown product";

  if (error) return <Alert title="Could not load the dashboard">{error}</Alert>;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={clinicName + " · " + today}
        actions={
          canMove ? (
            <>
              <Link href="/receive"><Button variant="secondary"><ArrowDownToLine size={15} aria-hidden /> Receive</Button></Link>
              <Link href="/issue"><Button><ArrowUpFromLine size={15} aria-hidden /> Record usage</Button></Link>
            </>
          ) : null
        }
      />

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="h-24 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Active products" value={summary.totalProducts} />
            <StatCard
              label="Units on hand" value={summary.totalUnits}
              sub={summary.issuableUnits !== summary.totalUnits ? summary.issuableUnits + " usable today" : "all stock usable"}
            />
            <StatCard
              label="Low stock" value={summary.lowStockCount}
              sub={summary.lowStockCount === 1 ? "product at or below reorder level" : "products at or below reorder level"}
              tone={summary.lowStockCount > 0 ? "warn" : "accent"}
            />
            <StatCard
              label="Expired batches" value={summary.expiredBatches}
              sub={summary.expiredUnits > 0 ? summary.expiredUnits + " units to write off" : "nothing to write off"}
              tone={summary.expiredBatches > 0 ? "danger" : "accent"}
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <StatCard label="Expiring soon" value={summary.expiringSoonBatches} sub={"within " + bands.soonDays + " days"} tone={summary.expiringSoonBatches > 0 ? "warn" : "neutral"} />
            <StatCard label="Approaching expiry" value={summary.approachingBatches} sub={"within " + bands.approachingDays + " days"} />
            <StatCard label="No expiry recorded" value={summary.noExpiryBatches} sub="cannot be ranked by expiry" />
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Needs attention</h2>
                <span className="text-xs text-muted">{attention.length} batches</span>
              </div>
              {attention.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="Nothing expiring soon">
                    No batch holding stock is expired or within {bands.soonDays} days of expiry.
                  </EmptyState>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {attention.slice(0, 8).map(({ batch, status }) => (
                    <li key={batch.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <Link href={"/product?id=" + batch.product_id} className="truncate text-sm font-medium hover:text-accent hover:underline">
                          {productName(batch.product_id)}
                        </Link>
                        <p className="tabular text-xs text-muted">
                          Batch {batch.batch_number} · {batch.quantity_on_hand} units
                          {batch.expiry_date ? " · " + batch.expiry_date : ""}
                        </p>
                      </div>
                      <ExpiryBadge status={status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Low stock</h2>
                <span className="text-xs text-muted">{lowStock.length} products</span>
              </div>
              {lowStock.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No products are low">
                    Every active product is above its reorder level.
                  </EmptyState>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {lowStock.slice(0, 8).map((r) => (
                    <li key={r.product.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <Link href={"/product?id=" + r.product.id} className="truncate text-sm font-medium hover:text-accent hover:underline">
                          {r.product.name}
                        </Link>
                        <p className="tabular text-xs text-muted">{r.product.sku}</p>
                      </div>
                      <p className="tabular shrink-0 text-right text-xs">
                        <span className="font-medium text-warn">{r.total}</span>
                        <span className="text-muted"> / {r.product.reorder_level}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card className="mt-5 overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">Recent movements</h2>
              <Link href="/movements" className="text-xs font-medium text-accent hover:underline">
                View all
              </Link>
            </div>
            <MovementList movements={movements.slice(0, 8)} />
          </Card>

          {rows.length === 0 ? (
            <div className="mt-5">
              <EmptyState
                title="No products yet"
                action={can(role, "manage_products") ? (
                  <Link href="/product/edit"><Button><Plus size={15} aria-hidden /> Add a product</Button></Link>
                ) : undefined}
              >
                <Package size={16} className="mr-1 inline" aria-hidden />
                Start by adding the products your clinic keeps in stock.
              </EmptyState>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
