// SPDX-License-Identifier: AGPL-3.0-only
// Who may open a private review session or publish, decided from locally stored facts only: the
// deployment's hosting mode and access policy, and (hosted only) the entitlement derived for the
// repository owner's billing account. No billing-provider call, and nothing here counts contributors.
import type { AccessPolicy, HostingMode } from "@rendered-review/runtime";

export type OwnerType = "User" | "Organization";

/** The `entitlement` row for the owner's billing account. */
export interface LocalEntitlement {
  planId: string;
  source: "subscription" | "trial" | "manual";
  /** ISO timestamp; null means no end date. */
  validUntil: string | null;
}

export interface EntitlementInput {
  hostingMode: HostingMode;
  accessPolicy: AccessPolicy;
  /** `owner` or `owner/repo` entries, for the `allowlist` policy. */
  allowlist: string[];
  repo: { owner: string; name: string; private: boolean; ownerType: OwnerType };
  /** Is the GitHub App installed on the repository? Only the `installed` policy reads it. */
  installed?: boolean;
  /** Hosted mode only; other modes never read it. */
  entitlement?: LocalEntitlement | null;
  now: string;
}

export type EntitlementDecision =
  | { allowed: true; reason: "public" | "access-policy" | LocalEntitlement["source"] }
  | {
      allowed: false;
      reason:
        | "policy-disabled"
        | "not-allowlisted"
        | "not-installed"
        | "no-entitlement"
        | "entitlement-expired"
        | "individual-plan-org-repo";
    };

export function resolveEntitlement(input: EntitlementInput): EntitlementDecision {
  const { repo } = input;
  if (!repo.private) return { allowed: true, reason: "public" };

  // Every mode applies the local access policy first (hosted and dedicated default to `installed`).
  switch (input.accessPolicy) {
    case "disabled":
      return { allowed: false, reason: "policy-disabled" };
    case "allowlist": {
      const names = [repo.owner, `${repo.owner}/${repo.name}`].map((n) => n.toLowerCase());
      if (!input.allowlist.some((entry) => names.includes(entry.toLowerCase())))
        return { allowed: false, reason: "not-allowlisted" };
      break;
    }
    case "installed":
      if (!input.installed) return { allowed: false, reason: "not-installed" };
      break;
  }
  // Community: local policy only. Dedicated: the installation contract, enforced by the policy.
  if (input.hostingMode !== "hosted") return { allowed: true, reason: "access-policy" };

  const e = input.entitlement;
  if (!e || e.planId === "public") return { allowed: false, reason: "no-entitlement" };
  if (e.validUntil !== null && e.validUntil <= input.now) return { allowed: false, reason: "entitlement-expired" };
  // An Individual subscription covers its personal owner's repositories, never an organization's.
  if (e.planId === "individual" && repo.ownerType === "Organization")
    return { allowed: false, reason: "individual-plan-org-repo" };
  return { allowed: true, reason: e.source };
}
