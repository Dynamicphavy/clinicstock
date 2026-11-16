"use client";

/**
 * Receive stock (brief section 4): product, batch number, quantity, optional
 * supplier/cost, received date, expiry date if applicable and notes.
 */

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { receiveStockSchema, type ReceiveStockInput } from "@/domain/validation";
import { applyDomainError } from "@/lib/formErrors";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Button, Card, Field, PageHeader, Select, TextInput, Textarea,
} from "@/components/ui";

export default function ReceivePage() {
  return (
    <RequireCapability capability="move_stock">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <ReceiveForm />
      </Suspense>
    </RequireCapability>
  );
}

function ReceiveForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { repo, refresh, today } = useSession();
  const { products, loading } = useInventory();
  const [formError, setFormError] = useState<string | null>(null);
  const [noExpiry, setNoExpiry] = useState(false);

  const active = products.filter((p) => p.is_active);

  const {
    register, handleSubmit, setError, control,
    formState: { errors, isSubmitting },
  } = useForm<ReceiveStockInput>({
    resolver: zodResolver(receiveStockSchema),
    defaultValues: {
      product_id: params.get("product") ?? "",
      batch_number: "",
      quantity: undefined,
      received_at: today,
      expiry_date: null,
      unit_cost: null,
      notes: null,
    },
  });

  // useWatch subscribes to one field, so only this component re-renders when
  // it changes -- and unlike `watch()` it is safe for the React Compiler to
  // memoize around.
  const productId = useWatch({ control, name: "product_id" });
  const product = products.find((p) => p.id === productId);

  const onSubmit = async (values: ReceiveStockInput) => {
    setFormError(null);
    // The checkbox is UI state, not a field: the domain only understands
    // "expiry_date is null".
    const result = await repo.receiveStock({ ...values, expiry_date: noExpiry ? null : values.expiry_date });
    if (!result.ok) {
      setFormError(applyDomainError(result.error, setError));
      return;
    }
    refresh();
    router.push("/product?id=" + values.product_id);
  };

  if (loading) return <p className="text-sm text-muted">Loading products…</p>;

  if (active.length === 0) {
    return (
      <Alert title="No active products">
        Add a product before receiving stock.{" "}
        <Link href="/product/edit" className="underline">Add a product</Link>.
      </Alert>
    );
  }

  return (
    <>
      <PageHeader title="Receive stock" description="Record a delivery into a batch. Every receipt is logged with your name and the time." />

      <Card className="max-w-2xl p-5">
        {formError ? <div className="mb-4"><Alert title="Could not record this receipt">{formError}</Alert></div> : null}

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          <Field label="Product" htmlFor="product_id" required error={errors.product_id?.message}>
            <Select id="product_id" {...register("product_id")} aria-invalid={!!errors.product_id}>
              <option value="">Select a product</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Batch number" htmlFor="batch_number" required
              error={errors.batch_number?.message}
              hint="From the supplier's packaging. Receiving an existing batch number tops it up."
            >
              <TextInput id="batch_number" {...register("batch_number")} aria-invalid={!!errors.batch_number} autoComplete="off" />
            </Field>

            <Field
              label="Quantity received" htmlFor="quantity" required
              error={errors.quantity?.message}
              hint={product ? "Counted in " + product.unit : "Whole units only."}
            >
              <TextInput
                id="quantity" type="number" min={1} step={1}
                {...register("quantity", { valueAsNumber: true })}
                aria-invalid={!!errors.quantity}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Received on" htmlFor="received_at" required error={errors.received_at?.message}>
              <TextInput id="received_at" type="date" {...register("received_at")} aria-invalid={!!errors.received_at} />
            </Field>

            <Field
              label="Expiry date" htmlFor="expiry_date"
              error={errors.expiry_date?.message}
              hint="Leave blank only if this stock genuinely has no expiry date."
            >
              <TextInput
                id="expiry_date" type="date" disabled={noExpiry}
                {...register("expiry_date")}
                aria-invalid={!!errors.expiry_date}
              />
            </Field>
          </div>

          {/**
           * An explicit "no expiry" tick rather than just an empty field.
           *
           * A blank date is ambiguous: it could mean "this product never
           * expires" or "I did not find the date on the box". Those are
           * different facts and the clinic needs to tell them apart -- undated
           * stock cannot be ranked by FEFO, so it needs to be a deliberate
           * statement, not an omission.
           */}
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox" checked={noExpiry}
              onChange={(e) => setNoExpiry(e.target.checked)}
              className="mt-0.5 rounded border-line"
            />
            <span>
              This stock has no expiry date
              <span className="block text-xs text-muted">
                Undated stock cannot be ordered by expiry, so it is issued by oldest receipt date instead.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Unit cost (optional)" htmlFor="unit_cost"
              error={errors.unit_cost?.message}
              hint="Decimal, e.g. 12.50. Stored exactly, never as a float."
            >
              <TextInput id="unit_cost" inputMode="decimal" {...register("unit_cost")} aria-invalid={!!errors.unit_cost} placeholder="12.50" />
            </Field>
          </div>

          <Field label="Notes (optional)" htmlFor="notes" error={errors.notes?.message}>
            <Textarea id="notes" rows={2} {...register("notes")} />
          </Field>

          <div className="flex gap-2 border-t border-line pt-4">
            {/* `pending` disables the button for the whole submit, which is the
                duplicate-submission guard from brief section 7. A double-clicked
                receipt would post two +100 movements that nobody could later
                tell apart from a real second delivery. */}
            <Button type="submit" pending={isSubmitting} pendingLabel="Recording…">
              Record receipt
            </Button>
            <Link href={productId ? "/product?id=" + productId : "/inventory"}>
              <Button type="button" variant="secondary">Cancel</Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
