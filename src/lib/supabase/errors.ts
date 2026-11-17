/**
 * Translates Supabase / PostgREST failures into our DomainError.
 *
 * WHY THIS EXISTS: the screens were written in milestone 4 against
 * `Result<DomainError>` from the demo repository. If the Supabase repository
 * returned raw PostgREST errors instead, every form would need a second error
 * path -- and the whole point of the repository seam was that the UI should not
 * change. So the cloud errors are mapped back onto the same codes here.
 *
 * The mapping is possible because 0003/0005 put our own DomainErrorCode in the
 * SQL DETAIL field, which PostgREST returns as `details`. Everything else falls
 * back to the SQLSTATE.
 */
import type { PostgrestError } from "@supabase/supabase-js";
import { err, type DomainError, type DomainErrorCode, type Result } from "@/domain/errors";

const KNOWN_CODES = new Set<string>([
  "QUANTITY_NOT_POSITIVE", "QUANTITY_NOT_INTEGER", "DELTA_ZERO",
  "INSUFFICIENT_STOCK", "BATCH_EXPIRED", "BATCH_NOT_FOUND",
  "PRODUCT_NOT_FOUND", "PRODUCT_INACTIVE", "DUPLICATE_SKU",
  "DUPLICATE_BATCH_NUMBER", "REASON_REQUIRED", "MALFORMED_DATE",
  "EXPIRY_BEFORE_RECEIPT", "PERMISSION_DENIED", "CROSS_TENANT_DENIED",
  "INVALID_INPUT", "AUTH_REQUIRED", "SESSION_EXPIRED", "MOVEMENT_NOT_FOUND",
  "APPEND_ONLY_VIOLATION", "CONFLICT", "NETWORK_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
]);

/** Which form field a given code belongs beside, where there is one. */
const FIELD_FOR: Partial<Record<DomainErrorCode, string>> = {
  INSUFFICIENT_STOCK: "quantity",
  QUANTITY_NOT_POSITIVE: "quantity",
  BATCH_EXPIRED: "batch_id",
  BATCH_NOT_FOUND: "batch_id",
  PRODUCT_NOT_FOUND: "product_id",
  PRODUCT_INACTIVE: "product_id",
  DUPLICATE_SKU: "sku",
  DUPLICATE_BATCH_NUMBER: "batch_number",
  REASON_REQUIRED: "reason",
  DELTA_ZERO: "quantity_delta",
  EXPIRY_BEFORE_RECEIPT: "expiry_date",
};

function build(code: DomainErrorCode, message: string): DomainError {
  return { code, message, field: FIELD_FOR[code] };
}

/**
 * A fetch that never reached the server.
 *
 * Distinguished from every other failure because the user's next action differs:
 * a validation error means "fix this field", a network error means "try again".
 * Brief section 7: "Handle network failure without showing a false success."
 */
export function networkError(e: unknown): DomainError {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return {
    code: "NETWORK_UNAVAILABLE",
    message: offline
      ? "You appear to be offline. The change was NOT saved. Reconnect and try again."
      : "Could not reach the server. The change was NOT saved. Check your connection and try again." +
        (e instanceof Error && e.message ? " (" + e.message + ")" : ""),
  };
}

export function mapPostgrestError(e: PostgrestError): DomainError {
  // 1. Our own code, carried in DETAIL by the SQL functions. Most specific, so
  //    it wins.
  const detail = (e.details ?? "").trim();
  if (KNOWN_CODES.has(detail)) {
    return build(detail as DomainErrorCode, e.message || "That operation was refused.");
  }

  // 2. Standard SQLSTATEs, for failures raised by constraints rather than by
  //    our functions.
  switch (e.code) {
    case "23505": {
      // Unique violation. The constraint name says which rule was broken --
      // guessing from the message text would break the moment PostgreSQL
      // rewords it.
      const text = (e.message + " " + (e.details ?? "")).toLowerCase();
      if (text.includes("sku")) return build("DUPLICATE_SKU", "That SKU is already in use in this clinic.");
      if (text.includes("batch")) return build("DUPLICATE_BATCH_NUMBER", "That batch number already exists for this product.");
      if (text.includes("reversal")) return build("CONFLICT", "That movement has already been reversed.");
      return build("CONFLICT", "That record already exists.");
    }
    case "23514":
      return build("INVALID_INPUT", "The database rejected those values. Check the quantities and dates.");
    case "23503":
      return build("INVALID_INPUT", "That refers to a record which no longer exists.");
    case "42501":
      // Covers both an RLS refusal and a missing grant. From the user's side
      // they are the same event: the database said no.
      return build("PERMISSION_DENIED", "Your role does not allow that, or the record belongs to another clinic.");
    case "PGRST301":
    case "PGRST302":
      return build("SESSION_EXPIRED", "Your session has expired. Sign in again to continue.");
    case "PGRST204":
    case "PGRST205":
      return build("SERVICE_UNAVAILABLE", "The database schema is out of date. The migrations may not be applied.");
    case "57014":
      return build("SERVICE_UNAVAILABLE", "That took too long and was cancelled. Nothing was saved.");
    case "40001":
    case "40P01":
      // Serialisation failure or deadlock -- a genuine concurrency event. Safe
      // to retry, because the transaction rolled back entirely.
      return build("CONFLICT", "Someone else changed this stock at the same moment. Nothing was saved -- please try again.");
    default:
      return build("SERVICE_UNAVAILABLE", e.message || "The database refused that operation.");
  }
}

/** Wraps a Supabase call so callers get a Result instead of a thrown error. */
export async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && "message" in e) {
      const mapped = mapPostgrestError(e as PostgrestError);
      return err(mapped.code, mapped.message, mapped.field);
    }
    const net = networkError(e);
    return err(net.code, net.message);
  }
}
