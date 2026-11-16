"use client";

/**
 * Stock adjustment (brief section 4): batch, signed quantity change, reason and
 * notes. A reason is mandatory.
 *
 * This screen is how a clinic records count corrections, damage, loss and
 * expired write-offs. Note what it does NOT offer: a way to set the balance to
 * an absolute number. Staff enter the CHANGE, and the system derives the new
 * balance -- so the movement history always explains the difference between two
 * balances, which is the whole basis of the audit trail.
 */

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { adjustStockSchema, type AdjustStockInput } from "@/domain/validation";
import { expiryStatus } from "@/domain/expiry";
import { applyDomainError } from "@/lib/formErrors";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Button, Card, ExpiryBadge, Field, PageHeader, Select, TextInput, Textarea,
} from "@/components/ui";

/** Placeholder reason codes — confirm with the clinic (brief section 13). */
const REASONS = [
  "Stock count correction",
  "Damaged in storage",
  "Expired stock written off",
  "Lost or unaccounted",
  "Returned to supplier",
  "Data entry correction",
  "Other (see notes)",
];

export default function AdjustPage() {
  return (
    <RequireCapability capability="move_stock">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <AdjustForm />
      </Suspense>
    </RequireCapability>
  );
}

function AdjustForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { repo, refresh, today, bands } = useSession();
  const { products, batches, loading } = useInventory();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register, handleSubmit, setError, control,
    formState: { errors, isSubmitting },
  } = useForm<AdjustStockInput>({
    resolver: zodResolver(adjustStockSchema),
    defaultValues: { batch_id: params.get("batch") ?? "", quantity_delta: undefined, reason: "", notes: null },
  });

  const batchId = useWatch({ control, name: "batch_id" });
  const delta = useWatch({ control, name: "quantity_delta" });
  const batch = batches.find((b) => b.id === batchId);
  const product = products.find((p) => p.id === batch?.product_id);

  /** Grouped by product, because a bare list of batch numbers is unusable. */
  const grouped = useMemo(() => {
    return products
      .map((p) => ({ product: p, batches: batches.filter((b) => b.product_id === p.id) }))
      .filter((g) => g.batches.length > 0);
  }, [products, batches]);

  const onSubmit = async (values: AdjustStockInput) => {
    setFormError(null);
    const result = await repo.adjustStock(values);
    if (!result.ok) {
      setFormError(applyDomainError(result.error, setError));
      return;
    }
    refresh();
    router.push("/product?id=" + batch?.product_id);
  };

  if (loading) return <p className="text-sm text-muted">Loading batches…</p>;

  const projected =
    batch && typeof delta === "number" && Number.isFinite(delta)
      ? batch.quantity_on_hand + delta
      : null;

  return (
    <>
      <PageHeader
        title="Stock adjustment"
        description="Correct a count, or write off damaged, lost or expired stock. Every adjustment needs a reason."
      />

      <Card className="max-w-2xl p-5">
        {formError ? <div className="mb-4"><Alert title="Could not record this adjustment">{formError}</Alert></div> : null}

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          <Field
            label="Batch" htmlFor="batch_id" required
            error={errors.batch_id?.message}
            hint="Expired batches are listed here on purpose — writing them off is an adjustment."
          >
            <Select id="batch_id" {...register("batch_id")} aria-invalid={!!errors.batch_id}>
              <option value="">Select a batch</option>
              {grouped.map((g) => (
                <optgroup key={g.product.id} label={g.product.name + " (" + g.product.sku + ")"}>
                  {g.batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.batch_number} · {b.quantity_on_hand} on hand
                      {b.expiry_date ? " · expires " + b.expiry_date : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>

          {batch ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-background px-3 py-2 text-xs">
              <span className="tabular font-medium">{batch.quantity_on_hand} on hand</span>
              <ExpiryBadge status={expiryStatus(batch.expiry_date, today, bands)} />
              {product ? <span className="text-muted">counted in {product.unit}</span> : null}
            </div>
          ) : null}

          <Field
            label="Quantity change" htmlFor="quantity_delta" required
            error={errors.quantity_delta?.message}
            hint="Signed: -5 removes five units, 5 adds five. Zero is not an adjustment."
          >
            <TextInput
              id="quantity_delta" type="number" step={1}
              {...register("quantity_delta", { valueAsNumber: true })}
              aria-invalid={!!errors.quantity_delta}
              placeholder="-5"
            />
          </Field>

          {/**
           * Show the resulting balance before submitting.
           *
           * A signed delta is genuinely easy to get backwards, and the cost of
           * getting it wrong is a correction entry that itself needs correcting.
           * Showing the arithmetic is cheaper than another reversal.
           */}
          {projected !== null ? (
            projected < 0 ? (
              <Alert tone="error" title="This would leave a negative balance">
                {batch!.quantity_on_hand} on hand, change of {delta} gives {projected}.
                A batch cannot hold less than zero.
              </Alert>
            ) : (
              <p className="tabular rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">
                New balance would be {projected}{product ? " " + product.unit : ""}.
              </p>
            )
          ) : null}

          <Field
            label="Reason" htmlFor="reason" required
            error={errors.reason?.message}
            hint="Mandatory. An adjustment without a reason is an unexplained stock change."
          >
            <Select id="reason" {...register("reason")} aria-invalid={!!errors.reason}>
              <option value="">Select a reason</option>
              {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>

          <Field
            label="Notes (optional)" htmlFor="notes"
            error={errors.notes?.message}
            hint="Who counted, what was found, any reference. Future you will want this."
          >
            <Textarea id="notes" rows={2} {...register("notes")} />
          </Field>

          <div className="flex gap-2 border-t border-line pt-4">
            <Button type="submit" pending={isSubmitting} pendingLabel="Recording…">
              Record adjustment
            </Button>
            <Link href={batch ? "/product?id=" + batch.product_id : "/inventory"}>
              <Button type="button" variant="secondary">Cancel</Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
