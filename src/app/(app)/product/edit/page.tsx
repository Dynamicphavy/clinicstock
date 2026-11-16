"use client";

/**
 * Add / edit product (brief section 4).
 *
 * One screen for both, because the fields are identical and two screens would
 * be two places to fix a bug. `?id=` present means edit, absent means add.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSession } from "@/app/providers";
import { useInventory } from "@/hooks/useInventory";
import { productSchema, type ProductFormInput, type ProductFormOutput } from "@/domain/validation";
import { applyDomainError } from "@/lib/formErrors";
import { RequireCapability } from "@/components/layout/AppShell";
import {
  Alert, Button, Card, Field, PageHeader, Select, TextInput, Textarea,
} from "@/components/ui";

export default function ProductEditPage() {
  return (
    <RequireCapability capability="manage_products">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <ProductEditForm />
      </Suspense>
    </RequireCapability>
  );
}

function ProductEditForm() {
  const params = useSearchParams();
  const id = params.get("id");
  const router = useRouter();
  const { repo, refresh } = useSession();
  const { products, categories, loading } = useInventory();
  const [formError, setFormError] = useState<string | null>(null);

  const existing = id ? products.find((p) => p.id === id) ?? null : null;

  const {
    register, handleSubmit, reset, setError,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormInput, unknown, ProductFormOutput>({
    // The SAME schema the repository and any future import will use. The form
    // does not get its own private idea of what a valid product is.
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: "", sku: "", unit: "", category_id: null,
      reorder_level: 0, description: null, is_active: true,
    },
  });

  // Populate once the product has loaded. `reset` rather than per-field
  // setValue, so the form's "dirty" state starts clean and an accidental
  // navigation warning would be accurate.
  useEffect(() => {
    if (!existing) return;
    reset({
      name: existing.name,
      sku: existing.sku,
      unit: existing.unit,
      category_id: existing.category_id,
      reorder_level: existing.reorder_level,
      description: existing.description,
      is_active: existing.is_active,
    });
  }, [existing, reset]);

  if (id && loading) return <p className="text-sm text-muted">Loading product…</p>;
  if (id && !existing) {
    return (
      <Alert title="Product not found">
        <Link href="/inventory" className="underline">Back to inventory</Link>
      </Alert>
    );
  }

  const onSubmit = async (values: ProductFormOutput) => {
    setFormError(null);
    const result = existing
      ? await repo.updateProduct(existing.id, values)
      : await repo.createProduct(values);

    if (!result.ok) {
      // A duplicate SKU lands on the SKU field; anything without a field
      // becomes a form-level alert. Never a generic "something went wrong".
      setFormError(applyDomainError(result.error, setError));
      return;
    }
    refresh();
    router.push("/product?id=" + result.value.id);
  };

  return (
    <>
      <PageHeader
        title={existing ? "Edit product" : "Add product"}
        description={existing ? existing.sku : "Create a product master record. Stock is added afterwards as batches."}
      />

      <Card className="max-w-2xl p-5">
        {formError ? <div className="mb-4"><Alert title="Could not save">{formError}</Alert></div> : null}

        {/* noValidate: the browser's own bubbles would compete with our
            accessible, specific messages and cannot be styled or tested. */}
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          <Field label="Product name" htmlFor="name" required error={errors.name?.message}>
            <TextInput id="name" {...register("name")} aria-invalid={!!errors.name} autoComplete="off" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="SKU" htmlFor="sku" required error={errors.sku?.message}
              hint="Unique within this clinic. Stored in capitals."
            >
              <TextInput id="sku" {...register("sku")} aria-invalid={!!errors.sku} autoComplete="off" />
            </Field>

            <Field
              label="Counting unit" htmlFor="unit" required error={errors.unit?.message}
              hint="What one unit IS: box, piece, tablet, bottle. Agree this with the clinic."
            >
              <TextInput id="unit" {...register("unit")} aria-invalid={!!errors.unit} placeholder="box" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" htmlFor="category_id" error={errors.category_id?.message}>
              <Select id="category_id" {...register("category_id")}>
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>

            <Field
              label="Reorder level" htmlFor="reorder_level" required
              error={errors.reorder_level?.message}
              hint="Flagged as low stock at or below this total. Use 0 to never flag."
            >
              <TextInput
                id="reorder_level" type="number" min={0} step={1}
                // valueAsNumber: without it an <input type="number"> hands Zod
                // the STRING "100", which fails `z.number()` with a confusing
                // "expected number, received string".
                {...register("reorder_level", { valueAsNumber: true })}
                aria-invalid={!!errors.reorder_level}
              />
            </Field>
          </div>

          <Field label="Description" htmlFor="description" error={errors.description?.message}>
            <Textarea id="description" rows={3} {...register("description")} />
          </Field>

          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" {...register("is_active")} className="mt-0.5 rounded border-line" />
            <span>
              Active
              <span className="block text-xs text-muted">
                Inactive products stay in reports and keep their history, but cannot receive new stock.
              </span>
            </span>
          </label>

          <div className="flex gap-2 border-t border-line pt-4">
            <Button type="submit" pending={isSubmitting} pendingLabel="Saving…">
              {existing ? "Save changes" : "Create product"}
            </Button>
            <Link href={existing ? "/product?id=" + existing.id : "/inventory"}>
              <Button type="button" variant="secondary">Cancel</Button>
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
