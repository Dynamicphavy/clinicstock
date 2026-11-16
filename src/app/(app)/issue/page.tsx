"use client";

/**
 * Record usage / issue stock (brief section 4): product, batch, quantity,
 * reason and notes, recommending the FEFO batch first.
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info, TriangleAlert } from "lucide-react";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { issueStockSchema, type IssueStockInput } from "@/domain/validation";
import { issuableBatches, recommendFefoBatch } from "@/domain/stock";
import { expiryStatus } from "@/domain/expiry";
import { applyDomainError } from "@/lib/formErrors";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Button, Card, ExpiryBadge, Field, PageHeader, Select, TextInput, Textarea,
} from "@/components/ui";

/**
 * Starter reason codes.
 *
 * PLACEHOLDERS. Brief section 13 lists "What reason codes does the clinic
 * actually use?" as a discovery question, and inventing them here would bake a
 * guess into every historical record. Replace after the clinic interview.
 */
const REASONS = [
  "Ward usage",
  "Procedure / theatre",
  "Consultation",
  "Department transfer",
  "Training or demonstration",
  "Expired stock removed",
  "Other (see notes)",
];

export default function IssuePage() {
  return (
    <RequireCapability capability="move_stock">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <IssueForm />
      </Suspense>
    </RequireCapability>
  );
}

function IssueForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { repo, refresh, today, bands } = useSession();
  const { products, batches, loading } = useInventory();
  const [formError, setFormError] = useState<string | null>(null);
  const [productId, setProductId] = useState(params.get("product") ?? "");

  const {
    register, handleSubmit, setError, setValue, control,
    formState: { errors, isSubmitting },
  } = useForm<IssueStockInput>({
    resolver: zodResolver(issueStockSchema),
    defaultValues: { batch_id: params.get("batch") ?? "", quantity: undefined, reason: "", notes: null },
  });

  const productBatches = useMemo(
    () => batches.filter((b) => b.product_id === productId),
    [batches, productId],
  );
  const eligible = useMemo(() => issuableBatches(productBatches, today), [productBatches, today]);
  const fefo = useMemo(() => recommendFefoBatch(productBatches, today), [productBatches, today]);

  const selectedId = useWatch({ control, name: "batch_id" });
  const selected = productBatches.find((b) => b.id === selectedId);

  /**
   * Preselect the FEFO batch.
   *
   * RECOMMEND, not enforce. The brief says "Recommend FEFO batch first" -- and
   * a clinic has legitimate reasons to take another batch (one is physically at
   * the front of the shelf, another is reserved). Forcing the choice would get
   * the software worked around; recommending it and flagging the deviation
   * keeps the record honest.
   */
  useEffect(() => {
    if (fefo && !selectedId) setValue("batch_id", fefo.batch.id);
  }, [fefo, selectedId, setValue]);

  const onSubmit = async (values: IssueStockInput) => {
    setFormError(null);
    const result = await repo.issueStock(values);
    if (!result.ok) {
      setFormError(applyDomainError(result.error, setError));
      return;
    }
    refresh();
    router.push("/product?id=" + productId);
  };

  if (loading) return <p className="text-sm text-muted">Loading stock…</p>;

  const notFefo = fefo && selectedId && selectedId !== fefo.batch.id;

  return (
    <>
      <PageHeader title="Record usage" description="Issue stock from a specific batch. Expired batches cannot be issued." />

      <Card className="max-w-2xl p-5">
        {formError ? <div className="mb-4"><Alert title="Could not record this issue">{formError}</Alert></div> : null}

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          <Field label="Product" htmlFor="product" required>
            <Select
              id="product" value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                // Clear the batch: a batch id from the previous product would
                // be rejected by the domain, but with a confusing message.
                setValue("batch_id", "");
              }}
            >
              <option value="">Select a product</option>
              {products.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
              ))}
            </Select>
          </Field>

          {productId && eligible.length === 0 ? (
            <Alert tone="warn" title="No issuable stock">
              Every batch for this product is empty or expired. Expired stock stays
              visible for audit, but cannot be issued — remove it with an
              adjustment instead.
            </Alert>
          ) : null}

          {productId && eligible.length > 0 ? (
            <>
              <Field
                label="Batch" htmlFor="batch_id" required
                error={errors.batch_id?.message}
                hint="Only in-date batches with stock are listed."
              >
                <Select id="batch_id" {...register("batch_id")} aria-invalid={!!errors.batch_id}>
                  <option value="">Select a batch</option>
                  {eligible.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.batch_number} · {b.quantity_on_hand} available
                      {b.expiry_date ? " · expires " + b.expiry_date : " · no expiry recorded"}
                      {fefo?.batch.id === b.id ? "  (recommended)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>

              {fefo ? (
                <p className="flex items-start gap-1.5 text-xs text-muted">
                  <Info size={14} className="mt-px shrink-0" aria-hidden />
                  {/* The basis is named, never implied. Undated stock is ranked
                      by receipt date, and saying so is the brief's rule: "never
                      imply FEFO can rank undated stock". */}
                  {fefo.basis === "expiry"
                    ? "Recommended: batch " + fefo.batch.batch_number + ", the earliest to expire (" + fefo.daysToExpiry + " days)."
                    : "No batch has an expiry date, so the recommendation falls back to the oldest receipt: batch " + fefo.batch.batch_number + "."}
                </p>
              ) : null}

              {notFefo ? (
                <Alert tone="warn" title="Not the recommended batch">
                  <span className="flex items-start gap-1.5">
                    <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                    Batch {fefo.batch.batch_number} expires sooner. Issuing another
                    batch first risks the earlier one expiring unused.
                  </span>
                </Alert>
              ) : null}

              {selected ? (
                <div className="flex items-center gap-2 rounded-md bg-background px-3 py-2 text-xs">
                  <span className="tabular font-medium">{selected.quantity_on_hand} available</span>
                  <ExpiryBadge status={expiryStatus(selected.expiry_date, today, bands)} />
                </div>
              ) : null}

              <Field
                label="Quantity to issue" htmlFor="quantity" required
                error={errors.quantity?.message}
                hint={selected ? "At most " + selected.quantity_on_hand + "." : undefined}
              >
                <TextInput
                  id="quantity" type="number" min={1} step={1}
                  max={selected?.quantity_on_hand}
                  {...register("quantity", { valueAsNumber: true })}
                  aria-invalid={!!errors.quantity}
                />
              </Field>

              <Field
                label="Reason" htmlFor="reason" required
                error={errors.reason?.message}
                hint="Required. Placeholder list — confirm the clinic's own reason codes."
              >
                <Select id="reason" {...register("reason")} aria-invalid={!!errors.reason}>
                  <option value="">Select a reason</option>
                  {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              </Field>

              <Field label="Notes (optional)" htmlFor="notes" error={errors.notes?.message}>
                <Textarea id="notes" rows={2} {...register("notes")} />
              </Field>

              <div className="flex gap-2 border-t border-line pt-4">
                <Button type="submit" pending={isSubmitting} pendingLabel="Recording…">
                  Record usage
                </Button>
                <Link href={productId ? "/product?id=" + productId : "/inventory"}>
                  <Button type="button" variant="secondary">Cancel</Button>
                </Link>
              </div>
            </>
          ) : null}
        </form>
      </Card>
    </>
  );
}
