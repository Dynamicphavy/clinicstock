/**
 * Expiry calculations (brief section 7).
 *
 * Two deliberate design rules in this file:
 *
 * 1. `today` is always a PARAMETER, never read from the system clock inside
 *    these functions. A function that calls `new Date()` internally cannot be
 *    tested -- verifying "expiry tomorrow shows as expiring soon" would mean
 *    waiting until tomorrow. Passing it in makes every band testable instantly
 *    and lets the app use the CLINIC's local today rather than the browser's.
 *
 * 2. Dates are handled as "YYYY-MM-DD" strings parsed at UTC noon. Parsing a
 *    date-only string at UTC midnight and then formatting it in a timezone
 *    behind UTC shifts it to the previous day -- the classic off-by-one that
 *    would make a batch look expired a day early. Noon is far enough from both
 *    midnights that no real timezone offset can cross a day boundary.
 */
import type { DateOnly, ExpiryBands, ExpiryStatus } from "./types";
import { DEFAULT_EXPIRY_BANDS } from "./types";
import { MS_PER_DAY, isValidDateOnly, toUtcNoon } from "./dateOnly";

export { isValidDateOnly } from "./dateOnly";



/**
 * Whole days from `today` until `expiryDate`.
 *
 *   negative -> already expired
 *   0        -> expires today
 *   positive -> days remaining
 *   null     -> no expiry recorded, so the question has no answer
 *
 * Returning null rather than 0 or Infinity matters: Infinity would make undated
 * stock sort as "freshest" in a FEFO list, which is a claim we cannot make.
 */
export function daysToExpiry(
  expiryDate: DateOnly | null,
  today: DateOnly,
): number | null {
  if (expiryDate === null) return null;
  if (!isValidDateOnly(expiryDate)) {
    throw new Error("Malformed expiry date: " + expiryDate);
  }
  if (!isValidDateOnly(today)) {
    throw new Error("Malformed today: " + today);
  }
  return Math.round((toUtcNoon(expiryDate) - toUtcNoon(today)) / MS_PER_DAY);
}

/**
 * Map a batch's expiry date onto an operational warning band.
 *
 * Bands from the brief, with the default window:
 *   before today    -> expired
 *   0 to 30 days    -> expiring soon       (0 means "expires today")
 *   31 to 60 days   -> approaching expiry
 *   more than 60    -> valid
 *   no date         -> no expiry recorded
 *
 * Note the boundary: an expiry date EQUAL to today is "expiring soon", not
 * "expired". The brief defines expired as strictly "before today", and the
 * clinic can still use that stock during the day.
 */
export function expiryStatus(
  expiryDate: DateOnly | null,
  today: DateOnly,
  bands: ExpiryBands = DEFAULT_EXPIRY_BANDS,
): ExpiryStatus {
  const days = daysToExpiry(expiryDate, today);
  if (days === null) return "no_expiry_recorded";
  if (days < 0) return "expired";
  if (days <= bands.soonDays) return "expiring_soon";
  if (days <= bands.approachingDays) return "approaching_expiry";
  return "valid";
}

/** True only when we positively know the batch is expired. */
export function isExpired(expiryDate: DateOnly | null, today: DateOnly): boolean {
  const days = daysToExpiry(expiryDate, today);
  return days !== null && days < 0;
}

/** Human-readable labels for the UI. */
export const EXPIRY_STATUS_LABEL: Record<ExpiryStatus, string> = {
  expired: "Expired",
  expiring_soon: "Expiring soon",
  approaching_expiry: "Approaching expiry",
  valid: "Valid",
  no_expiry_recorded: "No expiry recorded",
};
