"use client";

/**
 * Inventory screen (brief section 4): searchable table with product, SKU,
 * category, quantity, reorder level, status and actions; filters for category,
 * stock and expiry.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { buildProductRows, matchesSearch, type ProductRow } from "@/domain/inventoryView";
import { can } from "@/domain/permissions";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ExpiryBadge,
  LoadingRows,
  PageHeader,
  Select,
  StockBadge,
  TextInput,
} from "@/components/ui";

type StockFilter = "all" | "low" | "out";
type ExpiryFilter = "all" | "expired" | "expiring_soon" | "approaching_expiry" | "no_expiry_recorded";

export default function InventoryPage() {
  const { today, bands, role } = useSession();
  const { products, batches, categories, loading, error } = useInventory();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [stock, setStock] = useState<StockFilter>("all");
  const [expiry, setExpiry] = useState<ExpiryFilter>("all");
  const [showInactive, setShowInactive] = useState(false);

  const rows = useMemo(
    () => buildProductRows(products, batches, today, bands),
    [products, batches, today, bands],
  );

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (!showInactive && !r.product.is_active) return false;
        if (!matchesSearch(r, query)) return false;
        if (category !== "all" && r.product.category_id !== category) return false;
        if (stock === "low" && !r.low) return false;
        if (stock === "out" && r.total !== 0) return false;
        if (expiry !== "all" && r.worstStatus !== expiry) return false;
        return true;
      }),
    [rows, query, category, stock, expiry, showInactive],
  );

  const canEdit = can(role, "manage_products");

  return (
    <>
      <PageHeader
        title="Inventory"
        description={filtered.length + " of " + rows.length + " products"}
        actions={
          // No button for a role that cannot use it -- brief section 14,
          // "no decorative or non-functional buttons".
          canEdit ? (
            <Link href="/product/edit">
              <Button>
                <Plus size={16} aria-hidden /> Add product
              </Button>
            </Link>
          ) : null
        }
      />

      {error ? (
        <Alert title="Could not load inventory">{error}</Alert>
      ) : (
        <>
          <Card className="mb-4 p-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="relative">
                <label htmlFor="search" className="sr-only">
                  Search products
                </label>
                <Search
                  size={15}
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
                />
                <TextInput
                  id="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name or SKU"
                  className="pl-9"
                />
              </div>

              <div>
                <label htmlFor="f-category" className="sr-only">Category</label>
                <Select id="f-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">All categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </div>

              <div>
                <label htmlFor="f-stock" className="sr-only">Stock level</label>
                <Select id="f-stock" value={stock} onChange={(e) => setStock(e.target.value as StockFilter)}>
                  <option value="all">Any stock level</option>
                  <option value="low">Low stock only</option>
                  <option value="out">Out of stock</option>
                </Select>
              </div>

              <div>
                <label htmlFor="f-expiry" className="sr-only">Expiry status</label>
                <Select id="f-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryFilter)}>
                  <option value="all">Any expiry status</option>
                  <option value="expired">Expired</option>
                  <option value="expiring_soon">Expiring soon</option>
                  <option value="approaching_expiry">Approaching expiry</option>
                  <option value="no_expiry_recorded">No expiry recorded</option>
                </Select>
              </div>
            </div>

            <label className="mt-3 flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="rounded border-line"
              />
              Show inactive products
            </label>
          </Card>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Products with stock totals, reorder level and expiry status
                </caption>
                <thead className="bg-background text-left text-xs tracking-wide text-muted uppercase">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">Product</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">SKU</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">On hand</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">Reorder at</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Stock</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Expiry</th>
                    <th scope="col" className="px-3 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>

                {loading ? (
                  <LoadingRows rows={5} cols={7} />
                ) : (
                  <tbody>
                    {filtered.map((row) => (
                      <InventoryRow key={row.product.id} row={row} />
                    ))}
                  </tbody>
                )}
              </table>
            </div>

            {/* Two different empty states, because they need two different
                answers: "you have no products" vs "your filters match none". */}
            {!loading && filtered.length === 0 ? (
              <div className="p-4">
                {rows.length === 0 ? (
                  <EmptyState
                    title="No products yet"
                    action={canEdit ? (
                      <Link href="/product/edit"><Button>Add the first product</Button></Link>
                    ) : undefined}
                  >
                    Add your clinic&apos;s products to start tracking batches and expiry dates.
                  </EmptyState>
                ) : (
                  <EmptyState
                    title="No products match these filters"
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setQuery("");
                          setCategory("all");
                          setStock("all");
                          setExpiry("all");
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  >
                    Try a different search term, or clear the filters to see all {rows.length} products.
                  </EmptyState>
                )}
              </div>
            ) : null}
          </Card>
        </>
      )}
    </>
  );
}

function InventoryRow({ row }: { row: ProductRow }) {
  const { product, total, issuable, low, worstStatus, batchCount } = row;
  return (
    <tr className="border-t border-line hover:bg-background">
      <td className="px-3 py-2.5">
        <Link href={"/product?id=" + product.id} className="font-medium text-foreground hover:text-accent hover:underline">
          {product.name}
        </Link>
        <p className="text-xs text-muted">
          {batchCount} {batchCount === 1 ? "batch" : "batches"}
          {!product.is_active ? " · inactive" : ""}
        </p>
      </td>
      <td className="tabular px-3 py-2.5 text-muted">{product.sku}</td>
      <td className="tabular px-3 py-2.5 text-right font-medium">
        {total}
        <span className="ml-1 text-xs font-normal text-muted">{product.unit}</span>
        {/* Surfaced only when the two numbers differ, so it reads as a warning
            rather than as noise on every row. */}
        {issuable !== total ? (
          <p className="text-xs font-normal text-warn">{issuable} usable</p>
        ) : null}
      </td>
      <td className="tabular px-3 py-2.5 text-right text-muted">{product.reorder_level}</td>
      <td className="px-3 py-2.5"><StockBadge low={low} /></td>
      <td className="px-3 py-2.5"><ExpiryBadge status={worstStatus} /></td>
      <td className="px-3 py-2.5 text-right">
        <Link href={"/product?id=" + product.id} className="text-xs font-medium text-accent hover:underline">
          View
        </Link>
      </td>
    </tr>
  );
}
