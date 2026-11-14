/**
 * The storage seam (brief section 9).
 *
 * The UI depends on THIS interface and never on localStorage or Supabase. That
 * buys two things:
 *   - every screen and rule can be built and tested before a database exists;
 *   - milestone 6 swaps the implementation with no UI changes.
 *
 * DOCUMENTED DEVIATION from the brief's sketch: the brief shows the mutating
 * methods as `Promise<void>`. These return `Promise<Result<T>>` instead,
 * because "you only have 10 left" is an expected outcome that the form must
 * display, not an exception. With a Result type TypeScript forces every caller
 * to handle the rejection; with `void` plus throwing, a forgotten try/catch
 * shows the user a false success -- exactly what brief section 7 warns against
 * ("Handle network failure without showing a false success").
 */
import type {
  Batch,
  Category,
  Product,
  Role,
  StockMovement,
} from "@/domain/types";
import type { Result } from "@/domain/errors";
import type {
  AdjustStockInput,
  IssueStockInput,
  ReceiveStockInput,
} from "@/domain/validation";

/** Who is acting, and in which clinic. Every call is scoped by this. */
export interface ActorContext {
  user_id: string;
  organization_id: string;
  role: Role;
}

export interface NewProductInput {
  name: string;
  sku: string;
  unit: string;
  category_id: string | null;
  reorder_level: number;
  description: string | null;
  is_active: boolean;
}

export interface InventoryRepository {
  getProducts(): Promise<Product[]>;
  getBatches(): Promise<Batch[]>;
  getBatchesForProduct(productId: string): Promise<Batch[]>;
  getCategories(): Promise<Category[]>;
  /** Newest first. */
  getMovements(limit?: number): Promise<StockMovement[]>;
  getMovementsForBatch(batchId: string): Promise<StockMovement[]>;

  createProduct(input: NewProductInput): Promise<Result<Product>>;
  updateProduct(
    id: string,
    input: Partial<NewProductInput>,
  ): Promise<Result<Product>>;

  /** Creates or tops up a batch and records a receipt movement, atomically. */
  receiveStock(input: ReceiveStockInput): Promise<Result<Batch>>;
  issueStock(input: IssueStockInput): Promise<Result<Batch>>;
  adjustStock(input: AdjustStockInput): Promise<Result<Batch>>;
  /**
   * Compensating movement. Never edits or deletes the original
   * (brief section 7: "do not erase the original transaction").
   */
  reverseMovement(movementId: string, reason: string): Promise<Result<Batch>>;
}
