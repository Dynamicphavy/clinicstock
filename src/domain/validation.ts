/**
 * Input schemas and stock-movement rules (brief section 7).
 *
 * Split in two on purpose:
 *
 *   Zod schemas  -> is this input the right SHAPE? (a positive integer, a
 *                   non-empty reason, a well-formed date)
 *   Rule checks  -> is this operation ALLOWED given current state? (enough
 *                   stock, batch not expired, role permitted)
 *
 * Shape errors can be caught in the browser with no data. State errors need the
 * batch, and will be re-checked inside the database where the row can be locked.
 */
import { z } from "zod";
import type { Batch, DateOnly, Role } from "./types";
import { isExpired, isValidDateOnly } from "./expiry";
import { can } from "./permissions";
import { err, ok, type Result } from "./errors";

/** Reusable: a countable quantity of stock. */
const positiveIntQuantity = z
  .number({ message: "Enter a quantity." })
  .int("Quantity must be a whole number.")
  .positive("Quantity must be greater than zero.");

const dateOnly = z
  .string()
  .refine(isValidDateOnly, "Enter a valid date as YYYY-MM-DD.");

/** A reason that is actually a reason -- not a space, not "x". */
const requiredReason = z
  .string()
  .trim()
  .min(3, "Give a reason of at least 3 characters.");

export const receiveStockSchema = z.object({
  product_id: z.string().min(1),
  batch_number: z.string().trim().min(1, "Enter a batch number."),
  quantity: positiveIntQuantity,
  received_at: dateOnly,
  expiry_date: dateOnly.nullable(),
  /** Decimal string, not a number: see the money note in types.ts. */
  unit_cost: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, "Enter a cost like 12.50.")
    .nullable()
    .optional(),
  supplier_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const issueStockSchema = z.object({
  batch_id: z.string().min(1, "Select a batch."),
  quantity: positiveIntQuantity,
  /** The brief requires a reason code for issue/usage, not just adjustments. */
  reason: requiredReason,
  notes: z.string().nullable().optional(),
});

export const adjustStockSchema = z.object({
  batch_id: z.string().min(1, "Select a batch."),
  /**
   * SIGNED delta, and zero is rejected. A zero adjustment records that nothing
   * happened, which is noise in an audit trail.
   */
  quantity_delta: z
    .number({ message: "Enter an adjustment." })
    .int("Adjustment must be a whole number.")
    .refine((n) => n !== 0, "Adjustment cannot be zero."),
  /** Mandatory. Brief section 7: "signed quantity delta with mandatory reason". */
  reason: requiredReason,
  notes: z.string().nullable().optional(),
});

export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;
export type IssueStockInput = z.infer<typeof issueStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

/** Turn the first Zod issue into our DomainError shape. */
function fromZod<T>(parsed: z.ZodSafeParseResult<T>): Result<T> {
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  return err("INVALID_INPUT", issue.message, issue.path.join("."));
}

export function validateReceiveInput(input: unknown): Result<ReceiveStockInput> {
  const parsed = fromZod(receiveStockSchema.safeParse(input));
  if (!parsed.ok) return parsed;
  const { received_at, expiry_date } = parsed.value;
  // Brief section 7: "Flag expiry date earlier than receipt date". Stock that
  // arrived already expired is nearly always a typo; a real case needs the
  // controlled admin workflow, not a silent accept.
  if (expiry_date !== null && expiry_date < received_at) {
    return err(
      "EXPIRY_BEFORE_RECEIPT",
      "Expiry date is before the receipt date. Check the dates.",
      "expiry_date",
    );
  }
  return parsed;
}

export function validateIssueInput(input: unknown): Result<IssueStockInput> {
  return fromZod(issueStockSchema.safeParse(input));
}

export function validateAdjustInput(input: unknown): Result<AdjustStockInput> {
  return fromZod(adjustStockSchema.safeParse(input));
}

/**
 * State rules for issuing stock. Runs AFTER shape validation, against the real
 * batch. Re-implemented in SQL in milestone 5, where the row is locked first.
 */
export function checkIssueAllowed(
  batch: Batch | undefined,
  quantity: number,
  today: DateOnly,
  role: Role,
): Result<Batch> {
  if (!can(role, "move_stock")) {
    return err("PERMISSION_DENIED", "Your role cannot change stock levels.");
  }
  if (!batch) {
    return err("BATCH_NOT_FOUND", "That batch no longer exists.", "batch_id");
  }
  if (isExpired(batch.expiry_date, today)) {
    return err(
      "BATCH_EXPIRED",
      "Batch " + batch.batch_number + " has expired and cannot be issued.",
      "batch_id",
    );
  }
  if (quantity > batch.quantity_on_hand) {
    return err(
      "INSUFFICIENT_STOCK",
      "Only " + batch.quantity_on_hand + " units remain in batch " +
        batch.batch_number + ".",
      "quantity",
    );
  }
  return ok(batch);
}

/**
 * State rules for an adjustment.
 *
 * Note what is NOT checked: expiry. A write-off of expired stock is exactly the
 * adjustment a clinic needs to record, so blocking it would trap expired units
 * on the books forever. What IS checked is that a negative adjustment cannot
 * push a batch below zero -- a negative balance is physically meaningless.
 */
export function checkAdjustAllowed(
  batch: Batch | undefined,
  quantityDelta: number,
  role: Role,
): Result<Batch> {
  if (!can(role, "move_stock")) {
    return err("PERMISSION_DENIED", "Your role cannot change stock levels.");
  }
  if (!batch) {
    return err("BATCH_NOT_FOUND", "That batch no longer exists.", "batch_id");
  }
  if (batch.quantity_on_hand + quantityDelta < 0) {
    return err(
      "INSUFFICIENT_STOCK",
      "That would leave a negative balance. Batch " + batch.batch_number +
        " holds " + batch.quantity_on_hand + " units.",
      "quantity_delta",
    );
  }
  return ok(batch);
}

export function checkReceiveAllowed(role: Role): Result<true> {
  if (!can(role, "move_stock")) {
    return err("PERMISSION_DENIED", "Your role cannot receive stock.");
  }
  return ok(true);
}
