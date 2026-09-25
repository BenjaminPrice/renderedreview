// SPDX-License-Identifier: AGPL-3.0-only
// The published plans must match the commercial model exactly (hosted plans, overage, trial).
import { describe, expect, it } from "vitest";
import { annualPrice, formatUsd, plans, TRIAL_DAYS, TRIAL_CONTRIBUTORS } from "./pricing";

describe("plans", () => {
  it("match the commercial model's hosted plans", () => {
    expect(plans.map(({ name, contributors, monthly, overage }) => ({ name, contributors, monthly, overage }))).toEqual(
      [
        { name: "Public", contributors: null, monthly: 0, overage: null },
        { name: "Individual", contributors: 1, monthly: 5, overage: null },
        { name: "Team", contributors: 10, monthly: 49, overage: 5 },
        { name: "Business", contributors: 50, monthly: 200, overage: 4 },
        { name: "Scale", contributors: 200, monthly: 600, overage: 3 },
      ],
    );
  });

  it("price a year at 11 months: one month free", () => {
    expect(plans.map(annualPrice)).toEqual([0, 55, 539, 2200, 6600]);
  });

  it("highlight Team as the free-trial plan", () => {
    expect(plans.filter((p) => p.featured).map((p) => p.name)).toEqual(["Team"]);
  });

  it("describe the no-card trial with Team capacity", () => {
    expect([TRIAL_DAYS, TRIAL_CONTRIBUTORS]).toEqual([30, 10]);
  });

  it("format US dollars with thousands separators", () => {
    expect([formatUsd(5), formatUsd(539), formatUsd(2200), formatUsd(6600)]).toEqual([
      "$5",
      "$539",
      "$2,200",
      "$6,600",
    ]);
  });
});
