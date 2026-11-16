"use client";

/**
 * Full movement history (brief section 2: "Append-only movement history with
 * user and timestamp").
 *
 * Read-only by construction: this screen has no edit or delete control, because
 * the repository exposes none for normal users. A correction is recorded as a
 * reversal from the product screen.
 */

import { useMemo, useState } from "react";
import { useInventory } from "@/hooks/useInventory";
import type { MovementType } from "@/domain/types";
import { RequireCapability } from "@/components/layout/AppShell";
import { Alert, Card, PageHeader, Select, TextInput } from "@/components/ui";
import { MovementList } from "@/components/inventory/MovementList";

const TYPES: { value: MovementType | "all"; label: string }[] = [
  { value: "all", label: "All movement types" },
  { value: "receipt", label: "Receipts" },
  { value: "issue", label: "Issues" },
  { value: "adjustment", label: "Adjustments" },
  { value: "reversal", label: "Reversals" },
];

export default function MovementsPage() {
  return (
    <RequireCapability capability="view_movement_history">
      <MovementsScreen />
    </RequireCapability>
  );
}

function MovementsScreen() {
  const { movements, batches, products, loading, error } = useInventory();
  const [type, setType] = useState<MovementType | "all">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filtered = useMemo(
    () =>
      movements.filter((m) => {
        if (type !== "all" && m.movement_type !== type) return false;
        // created_at is an ISO instant; slicing to 10 chars gives its calendar
        // date, which is what a date filter means to a user.
        const day = m.created_at.slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
        return true;
      }),
    [movements, type, from, to],
  );

  const batchLabel = (batchId: string) => {
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) return "unknown";
    const product = products.find((p) => p.id === batch.product_id);
    return (product ? product.name + " · " : "") + batch.batch_number;
  };

  if (error) return <Alert title="Could not load movement history">{error}</Alert>;

  return (
    <>
      <PageHeader
        title="Movement history"
        description={loading ? "Loading…" : filtered.length + " of " + movements.length + " movements"}
      />

      <Card className="mb-4 p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="m-type" className="sr-only">Movement type</label>
            <Select id="m-type" value={type} onChange={(e) => setType(e.target.value as MovementType | "all")}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="m-from" className="block text-xs text-muted">From</label>
            <TextInput id="m-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor="m-to" className="block text-xs text-muted">To</label>
            <TextInput id="m-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-4 text-sm text-muted">Loading movements…</p>
        ) : (
          <MovementList movements={filtered} batchLabel={batchLabel} emptyHint="No movements match these filters." />
        )}
      </Card>
    </>
  );
}
