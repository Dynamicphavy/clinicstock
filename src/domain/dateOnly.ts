/**
 * Calendar-date helpers, shared by expiry logic, seed data and tests.
 *
 * Everything parses at UTC NOON. A date-only string parsed at UTC midnight and
 * then read in any timezone behind UTC lands on the previous day -- the
 * off-by-one that would show a batch as expired a day early. Noon is 12 hours
 * from either midnight, further than any real timezone offset.
 */
import type { DateOnly } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MS_PER_DAY = 86_400_000;

/** True if the string is a well-formed, real calendar date. */
export function isValidDateOnly(value: string | null | undefined): boolean {
  if (!value || !DATE_ONLY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // Round-trip guards against 2026-02-30, which Date would silently roll over
  // to 2026-03-02 rather than reject.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/** Parse "YYYY-MM-DD" to epoch milliseconds at UTC noon. */
export function toUtcNoon(value: DateOnly): number {
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

/** Format epoch milliseconds back to "YYYY-MM-DD". */
export function formatDateOnly(ms: number): DateOnly {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Shift a calendar date by whole days. Negative goes backwards. */
export function addDays(value: DateOnly, days: number): DateOnly {
  return formatDateOnly(toUtcNoon(value) + days * MS_PER_DAY);
}

/**
 * The clinic's local today.
 *
 * Call this ONCE at the edge of the app (a page or provider) and pass the value
 * down. Domain functions must never call it themselves -- see the note at the
 * top of expiry.ts.
 */
export function todayInClinic(now: Date = new Date()): DateOnly {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

/**
 * Today in a specific IANA timezone, e.g. "Africa/Lagos".
 *
 * In cloud mode the clinic's timezone is a column on `organizations`, so the UI
 * can agree with the database about what day it is. The SQL functions compute
 * their own date server-side from the same column and do not trust this value
 * -- if the two ever disagree, the database wins and the UI is simply showing a
 * stale day.
 *
 * "en-CA" is not a style choice: that locale formats dates as YYYY-MM-DD, which
 * is exactly our DateOnly shape. Building the string by hand from
 * toLocaleString parts is where off-by-one bugs creep back in.
 */
export function todayInTimezone(timeZone: string, now: Date = new Date()): DateOnly {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unknown timezone throws. Falling back to the device's date is wrong by
    // at most a day and keeps the app usable; the database remains authoritative.
    return todayInClinic(now);
  }
}
