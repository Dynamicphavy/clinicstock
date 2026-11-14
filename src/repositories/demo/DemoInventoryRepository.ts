/**
 * localStorage-backed repository for demo mode (brief section 9).
 *
 * LIMITATIONS, stated plainly because the brief insists on it: this is
 * single-browser storage. It is not multi-user, it has no real concurrency
 * control, and it is not suitable for real clinic records. The DEMO label in
 * the UI is not decoration.
 *
 * What this class is FOR, beyond demos: it is the rehearsal for milestone 5.
 * Every rule enforced here must be enforced again in PostgreSQL, where it
 * becomes the real boundary. Writing it twice is the point -- see the note on
 * `applyMovement` below.
 */
import type { Batch, Category, DateOnly, Product, StockMovement } from "@/domain/types";
import { err, ok, type Result } from "@/domain/errors";
import {
  checkAdjustAllowed,
  checkIssueAllowed,
  checkReceiveAllowed,
  validateAdjustInput,
  validateIssueInput,
  validateReceiveInput,
  type AdjustStockInput,
  type IssueStockInput,
  type ReceiveStockInput,
} from "@/domain/validation";
import { can } from "@/domain/permissions";
import { todayInClinic } from "@/domain/dateOnly";
import type {
  ActorContext,
  InventoryRepository,
  NewProductInput,
} from "../InventoryRepository";
import { buildDemoDataset, DEMO_ORG_ID, type DemoDataset } from "./seed";
import { MemoryStore, type KeyValueStore } from "./storage";

const STORAGE_KEY = "clinicstock.demo.v1";

export class DemoInventoryRepository implements InventoryRepository {
  constructor(
    private actor: ActorContext,
    private store: KeyValueStore = new MemoryStore(),
    /** Injected so tests can pin "today". Never read the clock below this line. */
    private today: DateOnly = todayInClinic(),
  ) {}

  // ---------------------------------------------------------------- state

  private load(): DemoDataset {
    const raw = this.store.read(STORAGE_KEY);
    if (!raw) return this.seed();
    try {
      return JSON.parse(raw) as DemoDataset;
    } catch {
      // Corrupt or outdated demo data: reseed rather than crash the app.
      return this.seed();
    }
  }

  private save(data: DemoDataset): void {
    this.store.write(STORAGE_KEY, JSON.stringify(data));
  }

  private seed(): DemoDataset {
    const data = buildDemoDataset(this.today);
    this.save(data);
    return data;
  }

  /** The "Reset demo data" action the brief requires. */
  resetDemoData(): DemoDataset {
    this.store.remove(STORAGE_KEY);
    return this.seed();
  }

  /**
   * Tenant scope.
   *
   * In demo mode there is one organisation, so this filter looks pointless. It
   * is here deliberately: it keeps the repository's shape honest about the fact
   * that every read is scoped to one clinic, which is what Row Level Security
   * will enforce for real in milestone 5. Code that forgets tenancy in demo
   * mode tends to forget it in the cloud implementation too.
   */
  private scoped<T extends { organization_id: string }>(rows: T[]): T[] {
    return rows.filter((r) => r.organization_id === this.actor.organization_id);
  }

  // ---------------------------------------------------------------- reads

  async getProducts(): Promise<Product[]> {
    return this.scoped(this.load().products);
  }

  async getBatches(): Promise<Batch[]> {
    return this.scoped(this.load().batches);
  }

  async getBatchesForProduct(productId: string): Promise<Batch[]> {
    return (await this.getBatches()).filter((b) => b.product_id === productId);
  }

  async getCategories(): Promise<Category[]> {
    return this.scoped(this.load().categories);
  }

  async getMovements(limit?: number): Promise<StockMovement[]> {
    const rows = this.scoped(this.load().movements).sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    return limit ? rows.slice(0, limit) : rows;
  }

  async getMovementsForBatch(batchId: string): Promise<StockMovement[]> {
    return (await this.getMovements()).filter((m) => m.batch_id === batchId);
  }

  // ------------------------------------------------------------- products

  async createProduct(input: NewProductInput): Promise<Result<Product>> {
    if (!can(this.actor.role, "manage_products")) {
      return err("PERMISSION_DENIED", "Your role cannot add products.");
    }
    const data = this.load();
    const sku = input.sku.trim().toUpperCase();

    // SKU uniqueness is PER ORGANISATION, not global. Two different clinics may
    // each use "MED-001" -- that is their own numbering, not a conflict.
    const clash = data.products.some(
      (p) =>
        p.organization_id === this.actor.organization_id &&
        p.sku.toUpperCase() === sku,
    );
    if (clash) {
      return err("DUPLICATE_SKU", "SKU " + sku + " is already in use in this clinic.", "sku");
    }

    const created: Product = {
      id: "prod-" + crypto.randomUUID(),
      organization_id: this.actor.organization_id,
      category_id: input.category_id,
      name: input.name.trim(),
      sku,
      unit: input.unit,
      reorder_level: input.reorder_level,
      description: input.description,
      is_active: input.is_active,
      created_at: new Date().toISOString(),
    };
    data.products.push(created);
    this.save(data);
    return ok(created);
  }

  async updateProduct(
    id: string,
    input: Partial<NewProductInput>,
  ): Promise<Result<Product>> {
    if (!can(this.actor.role, "manage_products")) {
      return err("PERMISSION_DENIED", "Your role cannot edit products.");
    }
    const data = this.load();
    const index = data.products.findIndex(
      (p) => p.id === id && p.organization_id === this.actor.organization_id,
    );
    if (index === -1) {
      return err("PRODUCT_NOT_FOUND", "That product no longer exists.");
    }
    if (input.sku) {
      const sku = input.sku.trim().toUpperCase();
      const clash = data.products.some(
        (p) =>
          p.id !== id &&
          p.organization_id === this.actor.organization_id &&
          p.sku.toUpperCase() === sku,
      );
      if (clash) {
        return err("DUPLICATE_SKU", "SKU " + sku + " is already in use in this clinic.", "sku");
      }
      input = { ...input, sku };
    }
    const updated = { ...data.products[index], ...input };
    data.products[index] = updated;
    this.save(data);
    return ok(updated);
  }

  // --------------------------------------------------------------- stock

  /**
   * The one place a batch balance changes.
   *
   * Balance and history are written TOGETHER in a single save, so they cannot
   * disagree. That is this file's imitation of a database transaction -- and it
   * is only an imitation. Two browser tabs can still interleave reads here and
   * lose an update; JavaScript gives us no row lock. That is precisely why the
   * brief's critical rule says the real implementation must be a PostgreSQL
   * function doing `SELECT ... FOR UPDATE`. Demo mode is allowed to be
   * approximate about concurrency; the cloud implementation is not.
   */
  private applyMovement(
    data: DemoDataset,
    batchId: string,
    delta: number,
    movement_type: StockMovement["movement_type"],
    reason: string | null,
    notes: string | null,
    reverses_movement_id: string | null = null,
  ): Batch {
    const index = data.batches.findIndex((b) => b.id === batchId);
    const batch = data.batches[index];
    const updated: Batch = {
      ...batch,
      quantity_on_hand: batch.quantity_on_hand + delta,
    };
    data.batches[index] = updated;
    data.movements.push({
      id: "mov-" + crypto.randomUUID(),
      organization_id: this.actor.organization_id,
      batch_id: batchId,
      movement_type,
      quantity_delta: delta,
      reason,
      notes,
      performed_by: this.actor.user_id,
      created_at: new Date().toISOString(),
      reverses_movement_id,
    });
    this.save(data);
    return updated;
  }

  async receiveStock(input: ReceiveStockInput): Promise<Result<Batch>> {
    const permitted = checkReceiveAllowed(this.actor.role);
    if (!permitted.ok) return permitted;

    const parsed = validateReceiveInput(input);
    if (!parsed.ok) return parsed;
    const v = parsed.value;

    const data = this.load();
    const product = data.products.find(
      (p) => p.id === v.product_id && p.organization_id === this.actor.organization_id,
    );
    if (!product) return err("PRODUCT_NOT_FOUND", "That product no longer exists.", "product_id");
    if (!product.is_active) {
      return err("PRODUCT_INACTIVE", "This product is inactive. Reactivate it before receiving stock.", "product_id");
    }

    const existing = data.batches.find(
      (b) =>
        b.product_id === v.product_id &&
        b.organization_id === this.actor.organization_id &&
        b.batch_number.toUpperCase() === v.batch_number.toUpperCase(),
    );

    // Receiving into an EXISTING batch number tops it up rather than creating a
    // duplicate row. Batch number is unique per product (brief section 6), so a
    // second row with the same number would split one physical consignment
    // across two balances -- and break expiry reporting for it.
    if (existing) {
      if (existing.expiry_date !== v.expiry_date) {
        return err(
          "DUPLICATE_BATCH_NUMBER",
          "Batch " + existing.batch_number + " already exists for this product with a different expiry date.",
          "batch_number",
        );
      }
      return ok(
        this.applyMovement(data, existing.id, v.quantity, "receipt", "Stock received", v.notes ?? null),
      );
    }

    const created: Batch = {
      id: "batch-" + crypto.randomUUID(),
      organization_id: this.actor.organization_id,
      product_id: v.product_id,
      supplier_id: v.supplier_id ?? null,
      batch_number: v.batch_number.trim(),
      quantity_on_hand: 0,
      unit_cost: v.unit_cost ?? null,
      received_at: v.received_at,
      expiry_date: v.expiry_date,
      created_at: new Date().toISOString(),
    };
    data.batches.push(created);
    // Created at zero, then moved to its quantity, so the receipt appears in
    // history as a +N movement and the audit invariant holds.
    return ok(
      this.applyMovement(data, created.id, v.quantity, "receipt", "Stock received", v.notes ?? null),
    );
  }

  async issueStock(input: IssueStockInput): Promise<Result<Batch>> {
    const parsed = validateIssueInput(input);
    if (!parsed.ok) return parsed;
    const v = parsed.value;

    const data = this.load();
    const batch = data.batches.find(
      (b) => b.id === v.batch_id && b.organization_id === this.actor.organization_id,
    );

    const allowed = checkIssueAllowed(batch, v.quantity, this.today, this.actor.role);
    if (!allowed.ok) return allowed;

    // Negative delta: issuing REMOVES stock.
    return ok(
      this.applyMovement(data, allowed.value.id, -v.quantity, "issue", v.reason, v.notes ?? null),
    );
  }

  async adjustStock(input: AdjustStockInput): Promise<Result<Batch>> {
    const parsed = validateAdjustInput(input);
    if (!parsed.ok) return parsed;
    const v = parsed.value;

    const data = this.load();
    const batch = data.batches.find(
      (b) => b.id === v.batch_id && b.organization_id === this.actor.organization_id,
    );

    const allowed = checkAdjustAllowed(batch, v.quantity_delta, this.actor.role);
    if (!allowed.ok) return allowed;

    return ok(
      this.applyMovement(data, allowed.value.id, v.quantity_delta, "adjustment", v.reason, v.notes ?? null),
    );
  }

  /**
   * Compensating movement.
   *
   * The original row is left completely untouched. History shows both the
   * mistake and its correction, which is what makes the trail trustworthy --
   * and what the brief means by "an inventory officer must not silently edit or
   * delete historical movements".
   */
  async reverseMovement(movementId: string, reason: string): Promise<Result<Batch>> {
    if (!can(this.actor.role, "move_stock")) {
      return err("PERMISSION_DENIED", "Your role cannot reverse movements.");
    }
    if (reason.trim().length < 3) {
      return err("REASON_REQUIRED", "Give a reason of at least 3 characters.", "reason");
    }

    const data = this.load();
    const original = data.movements.find(
      (m) => m.id === movementId && m.organization_id === this.actor.organization_id,
    );
    if (!original) return err("BATCH_NOT_FOUND", "That movement no longer exists.");

    const already = data.movements.some((m) => m.reverses_movement_id === movementId);
    if (already) {
      return err("INVALID_INPUT", "That movement has already been reversed.");
    }

    const batch = data.batches.find((b) => b.id === original.batch_id);
    if (!batch) return err("BATCH_NOT_FOUND", "That batch no longer exists.");

    const delta = -original.quantity_delta;
    if (batch.quantity_on_hand + delta < 0) {
      return err(
        "INSUFFICIENT_STOCK",
        "Reversing this receipt would leave a negative balance -- the stock has already been issued.",
      );
    }

    return ok(
      this.applyMovement(data, batch.id, delta, "reversal", reason.trim(), null, movementId),
    );
  }
}

export { DEMO_ORG_ID };
