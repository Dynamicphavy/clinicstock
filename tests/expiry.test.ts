/**
 * Expiry band tests -- brief section 11 rows:
 *   "Expiry tomorrow", "Expiry 45 days away", "Expiry date in past",
 *   "No expiry date".
 *
 * `TODAY` is a fixed constant, not `new Date()`. A test that reads the real
 * clock is a test that can pass today and fail on 1 March in a leap year. Fix
 * the clock and the behaviour becomes the only variable.
 */
import { describe, expect, it } from "vitest";
import { addDays, isValidDateOnly, todayInClinic } from "@/domain/dateOnly";
import { daysToExpiry, expiryStatus, isExpired } from "@/domain/expiry";

const TODAY = "2026-11-14";

describe("daysToExpiry", () => {
  it("counts whole days forward", () => {
    expect(daysToExpiry(addDays(TODAY, 45), TODAY)).toBe(45);
  });

  it("returns 0 on the expiry date itself", () => {
    expect(daysToExpiry(TODAY, TODAY)).toBe(0);
  });

  it("goes negative once the date has passed", () => {
    expect(daysToExpiry(addDays(TODAY, -1), TODAY)).toBe(-1);
  });

  it("returns null for undated stock rather than 0 or Infinity", () => {
    // Infinity would sort undated stock as the freshest in a FEFO list, which
    // is a claim about physical stock that we have no basis to make.
    expect(daysToExpiry(null, TODAY)).toBeNull();
  });

  it("crosses month and year boundaries correctly", () => {
    expect(daysToExpiry("2027-01-01", "2026-12-31")).toBe(1);
    expect(daysToExpiry("2028-03-01", "2028-02-28")).toBe(2); // 2028 is a leap year
  });

  it("throws on a malformed date instead of guessing", () => {
    expect(() => daysToExpiry("14/11/2026", TODAY)).toThrow();
    expect(() => daysToExpiry("2026-02-30", TODAY)).toThrow();
  });
});

describe("expiryStatus (brief section 7 bands)", () => {
  it("expiry date in the past is expired", () => {
    expect(expiryStatus(addDays(TODAY, -1), TODAY)).toBe("expired");
    expect(expiryStatus(addDays(TODAY, -400), TODAY)).toBe("expired");
  });

  it("expiry tomorrow is expiring soon", () => {
    expect(expiryStatus(addDays(TODAY, 1), TODAY)).toBe("expiring_soon");
  });

  it("expiry today is expiring soon, NOT expired", () => {
    // The brief defines expired as strictly "before today". Stock expiring
    // today is still usable today, and calling it expired would block a
    // legitimate issue.
    expect(expiryStatus(TODAY, TODAY)).toBe("expiring_soon");
  });

  it("expiry 45 days away is approaching expiry", () => {
    expect(expiryStatus(addDays(TODAY, 45), TODAY)).toBe("approaching_expiry");
  });

  it("more than 60 days away is valid", () => {
    expect(expiryStatus(addDays(TODAY, 61), TODAY)).toBe("valid");
  });

  it("no expiry date is no_expiry_recorded", () => {
    expect(expiryStatus(null, TODAY)).toBe("no_expiry_recorded");
  });

  // Boundaries get their own test because off-by-one is the likeliest bug here
  // and the one a human reviewer is least likely to spot by reading.
  it("holds exactly at each band boundary", () => {
    expect(expiryStatus(addDays(TODAY, 0), TODAY)).toBe("expiring_soon");
    expect(expiryStatus(addDays(TODAY, 30), TODAY)).toBe("expiring_soon");
    expect(expiryStatus(addDays(TODAY, 31), TODAY)).toBe("approaching_expiry");
    expect(expiryStatus(addDays(TODAY, 60), TODAY)).toBe("approaching_expiry");
    expect(expiryStatus(addDays(TODAY, 61), TODAY)).toBe("valid");
  });

  it("respects a clinic's configured warning window", () => {
    const bands = { soonDays: 7, approachingDays: 14 };
    expect(expiryStatus(addDays(TODAY, 10), TODAY, bands)).toBe("approaching_expiry");
    expect(expiryStatus(addDays(TODAY, 10), TODAY)).toBe("expiring_soon");
  });
});

describe("isExpired", () => {
  it("is false for undated stock -- unknown is not the same as expired", () => {
    expect(isExpired(null, TODAY)).toBe(false);
  });
});

describe("date helpers", () => {
  it("rejects impossible calendar dates", () => {
    expect(isValidDateOnly("2026-02-30")).toBe(false);
    expect(isValidDateOnly("2026-13-01")).toBe(false);
    expect(isValidDateOnly("2026-2-1")).toBe(false);
    expect(isValidDateOnly("")).toBe(false);
    expect(isValidDateOnly(null)).toBe(false);
    expect(isValidDateOnly("2028-02-29")).toBe(true);
  });

  it("todayInClinic produces a parseable date-only string", () => {
    expect(isValidDateOnly(todayInClinic(new Date("2026-11-14T23:30:00")))).toBe(true);
  });
});
