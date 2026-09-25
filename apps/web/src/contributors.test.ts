// SPDX-License-Identifier: AGPL-3.0-only
// Monthly active private contributors: the billing period, recording, and the admin read.
import { describe, expect, it } from "vitest";
import { billingPeriod } from "./contributors";

describe("billingPeriod", () => {
  it("is the calendar month in UTC", () => {
    expect(billingPeriod(new Date("2026-09-25T12:00:00.000Z"))).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
  });

  it("rolls over at midnight UTC on the first, whatever the local time zone", () => {
    expect(billingPeriod(new Date("2026-09-30T23:59:59.999Z")).start).toBe("2026-09-01T00:00:00.000Z");
    expect(billingPeriod(new Date("2026-10-01T00:00:00.000Z")).start).toBe("2026-10-01T00:00:00.000Z");
    // Late on 31 December in New York is already January in UTC.
    expect(billingPeriod(new Date("2026-12-31T20:00:00-05:00"))).toEqual({
      start: "2027-01-01T00:00:00.000Z",
      end: "2027-02-01T00:00:00.000Z",
    });
  });
});
