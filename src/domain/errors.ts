/**
 * Domain error codes and the Result type.
 *
 * Why a Result type instead of throwing?
 *
 * A rejected stock issue is an EXPECTED outcome, not a crash. "You only have 10
 * left" is information the form should display next to the quantity field.
 * Exceptions are for the unexpected (a malformed date that should never have got
 * past the form). Making the expected failures part of the return type means
 * TypeScript forces every caller to handle them -- you cannot forget to check.
 *
 * The same codes are reused by the PostgreSQL functions in milestone 5, so the
 * UI maps one set of codes to messages regardless of which layer rejected the
 * operation.
 */
export type DomainErrorCode =
  | "QUANTITY_NOT_POSITIVE"
  | "QUANTITY_NOT_INTEGER"
  | "DELTA_ZERO"
  | "INSUFFICIENT_STOCK"
  | "BATCH_EXPIRED"
  | "BATCH_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_INACTIVE"
  | "DUPLICATE_SKU"
  | "DUPLICATE_BATCH_NUMBER"
  | "REASON_REQUIRED"
  | "MALFORMED_DATE"
  | "EXPIRY_BEFORE_RECEIPT"
  | "PERMISSION_DENIED"
  | "CROSS_TENANT_DENIED"
  | "INVALID_INPUT"
  /* Codes the database and the network can produce but localStorage cannot.
     Brief section 7 requires clear messages for "permission denied, session
     expired, conflict and unavailable service" -- so each is its own code
     rather than all collapsing into one "something went wrong". */
  | "AUTH_REQUIRED"
  | "SESSION_EXPIRED"
  | "MOVEMENT_NOT_FOUND"
  | "APPEND_ONLY_VIOLATION"
  | "CONFLICT"
  | "NETWORK_UNAVAILABLE"
  | "SERVICE_UNAVAILABLE";

export interface DomainError {
  code: DomainErrorCode;
  /** Message safe to show a clinic user: specific, no internals, no blame. */
  message: string;
  /** Form field to attach the message to, when there is one. */
  field?: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: DomainErrorCode,
  message: string,
  field?: string,
): Result<T> {
  return { ok: false, error: { code, message, field } };
}
