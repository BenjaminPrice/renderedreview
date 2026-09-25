// SPDX-License-Identifier: AGPL-3.0-only
// Server only: billing accounts and the repository entitlement check. A billing account belongs to
// one GitHub owner, found by host plus stable numeric ID (never login), so a rename keeps the account
// and its plan. A personal owner's account holds an Individual plan; an organization's holds an
// organization plan. Entitlement follows the repository's current owner, so a transferred repository
// is judged by its new owner's plan.
//
// Administration: GitHub is the source of truth. A personal account's admin is that GitHub user; an
// organization account's admins are the organization's GitHub admins (`githubOwnerRole`, asked with
// the user's own token, which needs the GitHub App's organization "Members: read" permission). The
// answer is cached server-side in `membership` and must be re-checked before any billing change.
import {
  type EntitlementDecision,
  type LocalEntitlement,
  type OwnerType,
  resolveEntitlement,
} from "@rendered-review/control-plane";
import { type AppConfig, errorName, log, type SqlDatabase } from "@rendered-review/runtime";
import { type InstallationCheck, installationCheckFor } from "./github/installation";
import { type Account, upsertOwner } from "./github/installations";
import { apiBase } from "./github/proxy";
import { ownerTrial, trialContributorCapReached } from "./trial";

export type BillingAccountKind = "individual" | "organization";
export type MembershipRole = "admin" | "member";

const kindOf = (type: OwnerType): BillingAccountKind => (type === "User" ? "individual" : "organization");

/** The owner's billing account, created on first use. Also refreshes the owner's login. */
export async function billingAccountFor(
  db: SqlDatabase,
  host: string,
  owner: Account,
): Promise<{ id: string; kind: BillingAccountKind }> {
  const now = new Date().toISOString();
  await upsertOwner(db, host, owner, now);
  const current = async () =>
    (
      await db.all<{ id: string | null; type: OwnerType }>(
        "SELECT billing_account_id AS id, type FROM github_owner WHERE host = ? AND github_id = ?",
        [host, owner.id],
      )
    )[0]!;
  const row = await current();
  if (row.id) return { id: row.id, kind: kindOf(row.type) };

  const id = crypto.randomUUID();
  await db.run("INSERT INTO billing_account (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
    id,
    owner.login,
    now,
    now,
  ]);
  const { changes } = await db.run(
    "UPDATE github_owner SET billing_account_id = ? WHERE host = ? AND github_id = ? AND billing_account_id IS NULL",
    [id, host, owner.id],
  );
  if (changes > 0) return { id, kind: kindOf(row.type) };
  // A concurrent request attached its account first: use that one.
  await db.run("DELETE FROM billing_account WHERE id = ?", [id]);
  const winner = await current();
  return { id: winner.id!, kind: kindOf(winner.type) };
}

/** The locally derived entitlement of the owner's billing account; null without one. */
export async function ownerEntitlement(
  db: SqlDatabase,
  host: string,
  ownerGithubId: string,
): Promise<LocalEntitlement | null> {
  const [row] = await db.all<LocalEntitlement>(
    `SELECT e.plan_id AS "planId", e.source, e.valid_until AS "validUntil"
     FROM github_owner o JOIN entitlement e ON e.billing_account_id = o.billing_account_id
     WHERE o.host = ? AND o.github_id = ?`,
    [host, ownerGithubId],
  );
  return row ?? null;
}

/** Caches the user's GitHub-derived role on the account; null removes the membership. */
export async function setMembershipRole(
  db: SqlDatabase,
  billingAccountId: string,
  userId: string,
  role: MembershipRole | null,
) {
  if (!role) {
    await db.run("DELETE FROM membership WHERE billing_account_id = ? AND user_id = ?", [billingAccountId, userId]);
    return;
  }
  await db.run(
    `INSERT INTO membership (billing_account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (billing_account_id, user_id) DO UPDATE SET role = excluded.role`,
    [billingAccountId, userId, role, new Date().toISOString()],
  );
}

/** Billing accounts the user administers (the billing account switcher's list). */
export async function adminAccounts(db: SqlDatabase, userId: string) {
  const rows = await db.all<{ id: string; type: OwnerType; host: string; login: string }>(
    `SELECT m.billing_account_id AS id, o.type, o.host, o.login
     FROM membership m JOIN github_owner o ON o.billing_account_id = m.billing_account_id
     WHERE m.user_id = ? AND m.role = 'admin' ORDER BY o.host, o.login`,
    [userId],
  );
  return rows.map(({ id, type, host, login }) => ({ id, kind: kindOf(type), host, login }));
}

/**
 * The user's role for the owner's billing account, from GitHub: `admin` for their own personal
 * account or an organization they administer, `member` for other active organization members
 * (billing managers included), else null.
 */
export async function githubOwnerRole({
  host,
  token,
  owner,
  fetch: fetchFn = fetch,
}: {
  host: string;
  token: string;
  owner: Pick<Account, "id" | "login" | "type">;
  fetch?: typeof fetch;
}): Promise<MembershipRole | null> {
  const path = owner.type === "User" ? "user" : `user/memberships/orgs/${encodeURIComponent(owner.login)}`;
  const res = await fetchFn(`${apiBase(host)}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rendered-review",
      authorization: `Bearer ${token}`,
    },
  });
  // 404: not a member. 403: the organization blocks the app.
  if (res.status === 404 || res.status === 403) return null;
  if (res.status !== 200) throw new Error(`GitHub owner role lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { id?: unknown; state?: unknown; role?: unknown };
  if (owner.type === "User") return String(body.id) === owner.id ? "admin" : null;
  if (body.state !== "active") return null;
  return body.role === "admin" ? "admin" : "member";
}

/** A private repository, with its current owner as GitHub reports it. */
export interface PrivateRepository {
  host: string;
  owner: string;
  name: string;
  ownerId: string;
  ownerType: OwnerType;
}
/**
 * Who is asking, signed in: any private read may start the owner's trial (the repository facts
 * come from GitHub with this user's token, so they can see it); writes count against its contributor cap.
 */
export interface Requester {
  userId: string;
  operation: "read" | "write";
}
export type EntitlementCheck = (repo: PrivateRepository, requester?: Requester) => Promise<EntitlementDecision>;

/**
 * The deployment's private-repository entitlement check. Undefined in community mode, so callers
 * keep refusing private repositories there exactly as before, and nothing reads billing tables.
 *
 * Decided from stable IDs plus GitHub's live answers: the owner is looked up by the ID GitHub reports
 * for the repository, and installation by asking GitHub (`installed` defaults to the live check).
 * The webhook-fed installation tables match by login and name, so a missed rename could make them
 * say "installed" for the wrong repository: they never authorize private access.
 */
export function entitlementCheckFor(
  config: AppConfig,
  db: SqlDatabase | undefined,
  installed: InstallationCheck | undefined = installationCheckFor(config),
): EntitlementCheck | undefined {
  const { hostingMode, accessPolicy, allowlist, authSecret } = config;
  if (hostingMode === "community" || !db) return undefined;
  // Hosted private access always needs the installation; elsewhere only the `installed` policy asks.
  const needsInstallation = hostingMode === "hosted" || accessPolicy === "installed";
  return async (repo, requester) => {
    const isInstalledNow = needsInstallation ? await isInstalled(installed, repo) : undefined;
    const decide = (entitlement: LocalEntitlement | null) =>
      resolveEntitlement({
        hostingMode,
        accessPolicy,
        allowlist,
        repo: { owner: repo.owner, name: repo.name, private: true, ownerType: repo.ownerType },
        installed: isInstalledNow,
        entitlement,
        now: new Date().toISOString(),
      });
    if (hostingMode !== "hosted") return decide(null);

    const entitlement = await ownerEntitlement(db, repo.host, repo.ownerId);
    let decision = decide(entitlement);
    if (!requester || !authSecret) return decision;
    // No plan yet (or an ended trial, which the ledger may still hold as active): the owner's trial decides.
    if ((decision.reason === "no-entitlement" && !entitlement) || decision.reason === "trial-expired") {
      const owner = { id: repo.ownerId, login: repo.owner, type: repo.ownerType };
      decision = decide(await ownerTrial(db, authSecret, repo.host, owner));
    }
    if (
      decision.reason === "trial" &&
      requester.operation === "write" &&
      (await trialContributorCapReached(db, repo.host, repo.ownerId, requester.userId))
    )
      return { allowed: false, reason: "trial-contributor-cap" };
    return decision;
  };
}

/** Fails closed: an installation check that cannot answer counts as not installed. */
async function isInstalled(installed: InstallationCheck | undefined, repo: PrivateRepository) {
  try {
    return (await installed?.(repo.host, repo.owner, repo.name)) ?? false;
  } catch (error) {
    log.warn("billing.installation_check", { category: "failed", error: errorName(error), host: repo.host });
    return false;
  }
}
