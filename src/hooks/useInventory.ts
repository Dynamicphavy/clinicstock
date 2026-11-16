"use client";

/**
 * Loads everything the inventory screens need, with explicit loading and error
 * states (brief section 4: "Make empty, loading, success and error states
 * explicit").
 *
 * One hook for products + batches + movements rather than three, because every
 * screen that needs one needs at least two of them -- a product row is
 * meaningless without its batches. Three separate hooks would also give three
 * independent loading flags and a screen that renders in pieces.
 */

import { useCallback, useEffect, useState } from "react";
import type { Batch, Category, Product, StockMovement } from "@/domain/types";
import { useSession } from "@/app/providers";

export interface InventorySnapshot {
  products: Product[];
  batches: Batch[];
  movements: StockMovement[];
  categories: Category[];
}

const EMPTY: InventorySnapshot = {
  products: [],
  batches: [],
  movements: [],
  categories: [],
};

interface State {
  data: InventorySnapshot;
  loading: boolean;
  error: string | null;
}

export function useInventory() {
  const { repo, ready, version } = useSession();
  const [state, setState] = useState<State>({ data: EMPTY, loading: true, error: null });

  /**
   * Note the shape: the FIRST statement is an `await`.
   *
   * React's compiler rules reject state updates made synchronously inside an
   * effect -- they force a second render pass on every mount. Doing all the
   * work after an await boundary means this function never touches state in the
   * same tick the effect runs in. `loading` starts true from the initial state
   * instead of being set here.
   */
  const load = useCallback(async () => {
    try {
      // Parallel, because they are independent reads. Awaiting them in sequence
      // would be four round trips once this is Supabase rather than localStorage.
      const [products, batches, movements, categories] = await Promise.all([
        repo.getProducts(),
        repo.getBatches(),
        repo.getMovements(),
        repo.getCategories(),
      ]);
      setState({ data: { products, batches, movements, categories }, loading: false, error: null });
    } catch (e) {
      // Never leave the screen showing stale data as though it were fresh.
      setState({
        data: EMPTY,
        loading: false,
        error: e instanceof Error ? e.message : "Could not load inventory.",
      });
    }
  }, [repo]);

  useEffect(() => {
    if (!ready) return;
    /**
     * eslint-disable-next-line react-hooks/set-state-in-effect --
     * `load` touches state only AFTER its first `await`, so no state update
     * happens in this tick and there is no cascading render. The rule is a
     * static heuristic and cannot see across the await boundary.
     *
     * Fetching on mount genuinely needs an effect here: the repository's reads
     * are async by design (so the Supabase implementation can drop straight in),
     * and `useSyncExternalStore` only works for synchronous snapshots. The
     * alternative is a data-fetching library, which is a dependency this
     * milestone does not need.
     *
     * Disabling a rule is fine when you can explain why it does not apply.
     * Disabling it to make a red line disappear is not.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [ready, version, load]);

  /** For an explicit retry from a button. Safe to set state here: a click
   *  handler is not a render, so there is no cascading-render problem. */
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    void load();
  }, [load]);

  return {
    ...state.data,
    loading: state.loading || !ready,
    error: state.error,
    reload,
  };
}

/** Batches for one product, plus that product. */
export function useProduct(productId: string | null) {
  const { products, batches, movements, loading, error, reload } = useInventory();
  const product = productId ? products.find((p) => p.id === productId) ?? null : null;
  const productBatches = product ? batches.filter((b) => b.product_id === product.id) : [];
  const batchIds = new Set(productBatches.map((b) => b.id));
  const productMovements = movements.filter((m) => batchIds.has(m.batch_id));
  return { product, batches: productBatches, movements: productMovements, loading, error, reload };
}
