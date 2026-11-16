/**
 * Bridge between domain errors and react-hook-form.
 *
 * The domain returns `{ code, message, field? }`. A form needs the message
 * attached to the right input when there is one, and shown at the top of the
 * form when there is not (a permission denial belongs to the whole form, not
 * to the quantity box).
 *
 * This is why `DomainError` carries a `field` at all -- so the layer that knows
 * WHY something was rejected can say WHERE to show it, without the component
 * re-deriving that from an error code.
 */
import type { UseFormSetError, FieldValues, Path } from "react-hook-form";
import type { DomainError } from "@/domain/errors";

export function applyDomainError<T extends FieldValues>(
  error: DomainError,
  setError: UseFormSetError<T>,
): string | null {
  if (error.field) {
    setError(error.field as Path<T>, { type: "server", message: error.message });
    return null;
  }
  // No field: the caller shows this as a form-level alert.
  return error.message;
}
