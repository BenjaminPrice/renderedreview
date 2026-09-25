// SPDX-License-Identifier: AGPL-3.0-only
// One block per row of the entitlement table: public, private personal, private organization,
// dedicated hosted, community self-hosted.
import { describe, expect, it } from "vitest";
import { type EntitlementInput, resolveEntitlement } from "./entitlement";

const now = "2026-09-25T12:00:00.000Z";
const later = "2026-10-25T12:00:00.000Z";
const earlier = "2026-09-01T00:00:00.000Z";
const personal = { owner: "octo", name: "notes", private: true, ownerType: "User" } as const;
const org = { owner: "acme", name: "widgets", private: true, ownerType: "Organization" } as const;
const subscription = (planId: string, validUntil: string | null = later) =>
  ({ planId, source: "subscription", validUntil }) as const;

const hosted = (input: Partial<EntitlementInput>): EntitlementInput => ({
  hostingMode: "hosted",
  accessPolicy: "installed",
  allowlist: [],
  repo: personal,
  installed: true,
  entitlement: null,
  now,
  ...input,
});

describe("public repositories", () => {
  it.each(["hosted", "dedicated", "community"] as const)("are always free in %s mode", (hostingMode) => {
    expect(
      resolveEntitlement(
        hosted({ hostingMode, accessPolicy: "disabled", installed: false, repo: { ...org, private: false } }),
      ),
    ).toEqual({ allowed: true, reason: "public" });
  });
});

describe("private personal repositories (hosted)", () => {
  it("are covered by the owner's Individual subscription", () => {
    expect(resolveEntitlement(hosted({ entitlement: subscription("individual") }))).toEqual({
      allowed: true,
      reason: "subscription",
    });
  });

  it("are refused without one", () => {
    expect(resolveEntitlement(hosted({}))).toEqual({ allowed: false, reason: "no-entitlement" });
    expect(resolveEntitlement(hosted({ entitlement: subscription("public") }))).toEqual({
      allowed: false,
      reason: "no-entitlement",
    });
  });

  it("are covered by an active trial and refused once it expires", () => {
    const trial = { planId: "team", source: "trial", validUntil: later } as const;
    expect(resolveEntitlement(hosted({ entitlement: trial }))).toEqual({ allowed: true, reason: "trial" });
    expect(resolveEntitlement(hosted({ entitlement: { ...trial, validUntil: earlier } }))).toEqual({
      allowed: false,
      reason: "entitlement-expired",
    });
  });
});

describe("private organization repositories (hosted)", () => {
  it.each(["team", "business", "scale", "enterprise"])("are covered by an organization %s plan", (plan) => {
    expect(resolveEntitlement(hosted({ repo: org, entitlement: subscription(plan, null) }))).toEqual({
      allowed: true,
      reason: "subscription",
    });
  });

  it("are never covered by an Individual subscription", () => {
    expect(resolveEntitlement(hosted({ repo: org, entitlement: subscription("individual") }))).toEqual({
      allowed: false,
      reason: "individual-plan-org-repo",
    });
  });

  it("are refused without an organization subscription", () => {
    expect(resolveEntitlement(hosted({ repo: org }))).toEqual({ allowed: false, reason: "no-entitlement" });
    expect(resolveEntitlement(hosted({ repo: org, entitlement: subscription("team", earlier) }))).toEqual({
      allowed: false,
      reason: "entitlement-expired",
    });
  });

  it("need the installation whatever the access policy", () => {
    const entitlement = subscription("team");
    expect(
      resolveEntitlement(hosted({ repo: org, accessPolicy: "all-accessible", installed: false, entitlement })),
    ).toEqual({ allowed: false, reason: "not-installed" });
    expect(
      resolveEntitlement(
        hosted({ repo: org, accessPolicy: "allowlist", allowlist: ["acme"], installed: false, entitlement }),
      ),
    ).toEqual({ allowed: false, reason: "not-installed" });
  });

  it("compare the plan's end as an instant, not as text", () => {
    const until = (validUntil: string) =>
      resolveEntitlement(hosted({ repo: org, entitlement: subscription("team", validUntil) }));
    // Exactly the current instant, written without milliseconds: ended.
    expect(until("2026-09-25T12:00:00Z")).toEqual({ allowed: false, reason: "entitlement-expired" });
    // 16:00 at +05:00 is 11:00Z, an hour ago; 18:00 at +05:00 is 13:00Z, an hour ahead.
    expect(until("2026-09-25T16:00:00.000+05:00")).toEqual({ allowed: false, reason: "entitlement-expired" });
    expect(until("2026-09-25T18:00:00.000+05:00")).toEqual({ allowed: true, reason: "subscription" });
    // Unparseable: treated as ended.
    expect(until("soon")).toEqual({ allowed: false, reason: "entitlement-expired" });
  });

  it("still need the local access policy: a subscription does not replace the installation", () => {
    expect(resolveEntitlement(hosted({ repo: org, installed: false, entitlement: subscription("team") }))).toEqual({
      allowed: false,
      reason: "not-installed",
    });
  });
});

describe("dedicated hosting", () => {
  it("follows the installation and its policy, never a subscription", () => {
    const dedicated = (input: Partial<EntitlementInput>) => hosted({ hostingMode: "dedicated", repo: org, ...input });
    expect(resolveEntitlement(dedicated({}))).toEqual({ allowed: true, reason: "access-policy" });
    expect(resolveEntitlement(dedicated({ installed: false, entitlement: subscription("team") }))).toEqual({
      allowed: false,
      reason: "not-installed",
    });
  });
});

describe("community self-hosting", () => {
  const community = (input: Partial<EntitlementInput>) =>
    hosted({ hostingMode: "community", repo: org, installed: false, ...input });

  it("uses the local access policy only, whatever the billing state", () => {
    expect(resolveEntitlement(community({ accessPolicy: "disabled", entitlement: subscription("team") }))).toEqual({
      allowed: false,
      reason: "policy-disabled",
    });
    expect(resolveEntitlement(community({ accessPolicy: "all-accessible" }))).toEqual({
      allowed: true,
      reason: "access-policy",
    });
    expect(resolveEntitlement(community({ accessPolicy: "installed", installed: true }))).toEqual({
      allowed: true,
      reason: "access-policy",
    });
  });

  it("matches the allowlist by owner or owner/repo, ignoring case", () => {
    const allow = (allowlist: string[]) => resolveEntitlement(community({ accessPolicy: "allowlist", allowlist }));
    expect(allow(["ACME"])).toEqual({ allowed: true, reason: "access-policy" });
    expect(allow(["acme/Widgets"])).toEqual({ allowed: true, reason: "access-policy" });
    expect(allow(["acme/gadgets", "octo"])).toEqual({ allowed: false, reason: "not-allowlisted" });
  });
});
