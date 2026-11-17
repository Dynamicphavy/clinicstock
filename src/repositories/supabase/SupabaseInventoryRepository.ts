"use client";

/**
 * The cloud implementation of InventoryRepository.
 *
 * This is the payoff for the seam built in milestone 3. Every screen written in
 * milestone 4 calls this interface, so swapping localStorage for PostgreSQL
 * required no change to any component -- the UI does not know which of these
 * two objects it is holding.
 *
 * THE RULE THIS FILE EXISTS TO HONOUR (brief section 7):
 *
 *   Reads go to tables. Writes go to functions. Never the other way round.
 *
 * Every read below is `.from(table).select(...)`, relying on Row Level Security
 * to scope it. Every stock change is `.rpc(...)`, because 0002 and 0005 left no
 * write grant and no write policy on `batches` or `stock_movements` -- a direct
 * update would be refused by the database anyway. That refusal is the safety
 * net; this file is the correct path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Batch, Category, DateOnly, Product, StockMovement,
} from "@/domain/types";
import { err, type Result } from "@/domain/errors";
import {
  validateAdjustInput, validateIssueInput, validateReceiveInput,
  productSchema,
  type AdjustStockInput, type IssueStockInput, type ReceiveStockInput,
} from "@/domain/validation";
import { can } from "@/domain/permissions";
import { guard } from "@/lib/supabase/errors";
import type {
  ActorContext, InventoryRepository, NewProductInput,
} from "../InventoryRepository";

export class SupabaseInventoryRepository implements InventoryRepository {
  constructor(
    private db: SupabaseClient,
    private actor: ActorContext,
    /** Clinic-local today, derived from organizations.timezone. */
    private today: DateOnly,
  ) {}

  /**
   * Reads throw on failure rather than returning a Result.
   *
   * Deliberate asymmetry. A failed WRITE is usually an expected business
   * outcome ("only 10 left") that belongs beside a form field. A failed READ is
   * infrastructure -- offline, expired session, missing table -- and the screen
   * wants one error banner, which is what useInventory's try/catch already
   * provides. Dressing read failures as Results would force every caller to
   * handle a case it cannot act on.
   */
  private async read<T>(
    label: string,
    // PromiseLike, not Promise: a PostgREST query builder is *thenable* -- it
    // has .then() but not .catch() or .finally(), because awaiting it is what
    // sends the request. Typing this as Promise rejects the builder outright.
    run: () => PromiseLike<{ data: T | null; error: unknown }>,
  ): Promise<T> {
    const { data, error } = await run();
    if (error) {
      const e = error as { message?: string; code?: string };
      throw new Error(
        "Could not load " + label + (e.message ? ": " + e.message : "") +
        (e.code ? " [" + e.code + "]" : ""),
      );
    }
    return (data ?? []) as T;
  }

  /**
   * Note the absence of `.eq("organization_id", ...)` on these reads.
   *
   * It would be harmless, but leaving it out is the point: the filtering is
   * done by RLS using the verified JWT, not by a value this client could get
   * wrong or an attacker could change. Adding the filter here would invite the
   * belief that it is what provides the isolation. It is not.
   */
  async getProducts(): Promise<Product[]> {
    return this.read("products", () =>
      this.db.from("products").select("*").order("name"),
    );
  }

  async getBatches(): Promise<Batch[]> {
    return this.read("batches", () =>
      this.db.from("batches").select("*").order("expiry_date", { nullsFirst: false }),
    );
  }

  async getBatchesForProduct(productId: string): Promise<Batch[]> {
    return this.read("batches", () =>
      this.db.from("batches").select("*").eq("product_id", productId)
        .order("expiry_date", { nullsFirst: false }),
    );
  }

  async getCategories(): Promise<Category[]> {
    return this.read("categories", () =>
      this.db.from("categories").select("*").order("name"),
    );
  }

  async getMovements(limit = 200): Promise<StockMovement[]> {
    // Bounded by default. The demo had a handful of rows; a real clinic
    // accumulates thousands, and an unbounded select would grow slower every
    // week until someone noticed.
    return this.read("movement history", () =>
      this.db.from("stock_movements").select("*")
        .order("created_at", { ascending: false }).limit(limit),
    );
  }

  async getMovementsForBatch(batchId: string): Promise<StockMovement[]> {
    return this.read("movement history", () =>
      this.db.from("stock_movements").select("*").eq("batch_id", batchId)
        .order("created_at", { ascending: false }),
    );
  }

  /* ------------------------------------------------------------- products */

  // Products are an ordinary table write: there is no balance to lock and no
  // movement to record, and RLS already restricts it to staff of one clinic.
  // Wrapping it in a function would add a layer that protects nothing.

  async createProduct(input: NewProductInput): Promise<Result<Product>> {
    if (!can(this.actor.role, "manage_products")) {
      return err("PERMISSION_DENIED", "Your role cannot add products.");
    }
    const parsed = productSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err("INVALID_INPUT", issue.message, issue.path.join("."));
    }
    return guard(async () => {
      const { data, error } = await this.db
        .from("products")
        // organization_id is supplied because the column is NOT NULL -- but the
        // RLS WITH CHECK re-verifies it against the caller's membership, so a
        // forged value is refused rather than trusted.
        .insert({ ...parsed.data, organization_id: this.actor.organization_id })
        .select()
        .single();
      if (error) throw error;
      return data as Product;
    });
  }

  async updateProduct(id: string, input: Partial<NewProductInput>): Promise<Result<Product>> {
    if (!can(this.actor.role, "manage_products")) {
      return err("PERMISSION_DENIED", "Your role cannot edit products.");
    }
    const parsed = productSchema.partial().safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err("INVALID_INPUT", issue.message, issue.path.join("."));
    }
    return guard(async () => {
      const { data, error } = await this.db
        .from("products").update(parsed.data).eq("id", id).select().single();
      if (error) throw error;
      return data as Product;
    });
  }

  /* ---------------------------------------------------------- stock moves */

  /**
   * Client-side validation runs FIRST, then the function validates again.
   *
   * Not redundant: this round trip is over a network. Catching "quantity must
   * be positive" locally gives the user an instant answer instead of a
   * 300ms wait for a result we could already predict. The database check is
   * the one that counts; this one is the one that feels fast.
   */
  async receiveStock(input: ReceiveStockInput): Promise<Result<Batch>> {
    const parsed = validateReceiveInput(input);
    if (!parsed.ok) return parsed;
    const v = parsed.value;

    return guard(async () => {
      const { data, error } = await this.db.rpc("receive_stock", {
        p_product_id: v.product_id,
        p_batch_number: v.batch_number,
        p_quantity: v.quantity,
        p_received_at: v.received_at,
        p_expiry_date: v.expiry_date,
        p_unit_cost: v.unit_cost ?? null,
        p_supplier_id: v.supplier_id ?? null,
        p_notes: v.notes ?? null,
      });
      if (error) throw error;
      return data as Batch;
    });
  }

  async issueStock(input: IssueStockInput): Promise<Result<Batch>> {
    const parsed = validateIssueInput(input);
    if (!parsed.ok) return parsed;
    const v = parsed.value;

    return guard(async () => {
      // No p_today. The function reads the clinic's date from its own timezone
      // column, so a tampered client clock cannot make expired stock issuable.
      const { data, error } = await this.db.rpc("issue_stock", {
        p_batch_id: v.batch_id,
        p_quantity: v.quantity,
        p_reason: v.reason,
        p_notes: v.notes ?? null,
      });
      if (error) throw error;
      return data as Batch;
    });
  }

  async adjustStock(input: AdjustStockInput): Promise<Result<Batch>> {
    const parsed = validateAdjustInput(input);
    if (!parsed.ok) return parsed;
    const v = parsed.value;

    return guard(async () => {
      const { data, error } = await this.db.rpc("adjust_stock", {
        p_batch_id: v.batch_id,
        p_quantity_delta: v.quantity_delta,
        p_reason: v.reason,
        p_notes: v.notes ?? null,
      });
      if (error) throw error;
      return data as Batch;
    });
  }

  async reverseMovement(movementId: string, reason: string): Promise<Result<Batch>> {
    if (reason.trim().length < 3) {
      return err("REASON_REQUIRED", "Give a reason of at least 3 characters.", "reason");
    }
    return guard(async () => {
      const { data, error } = await this.db.rpc("reverse_movement", {
        p_movement_id: movementId,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as Batch;
    });
  }

  /** Unused by the UI; kept so the clinic-local date is visible in one place. */
  get clinicToday(): DateOnly {
    return this.today;
  }
}
