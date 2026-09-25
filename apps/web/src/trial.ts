// SPDX-License-Identifier: AGPL-3.0-only
// Server only: the hosted no-card private-repository trial. Team capacity for 30 days, once per
// stable GitHub owner, started by the first signed-in private read.
//
// The ledger (`trial`) is keyed by HMAC-SHA256(host, subject type, owner ID) under a subkey that
// HKDF derives from BETTER_AUTH_SECRET, so it holds no GitHub ID or login and is not joined to
// `github_owner`. Rename, reinstall, another repository or a deleted and recreated billing account
// all hash to the same key, so none of them grants a second trial. Rotating BETTER_AUTH_SECRET
// changes every key: existing owners could then start a new trial.
import type { LocalEntitlement, OwnerType } from "@rendered-review/control-plane";
import type { SqlDatabase } from "@rendered-review/runtime";
import { billingAccountFor } from "./billing";
import { activeContributors } from "./contributors";
import type { Account } from "./github/installations";

export const TRIAL_DAYS = 30;
/** Active private contributors a trial covers; sales-approved trials raise it on the ledger and entitlement. */
export const TRIAL_CONTRIBUTORS = 10;

const encoder = new TextEncoder();

/** The owner's ledger key, hex. The host is case-insensitive. */
export async function trialSubjectKey(secret: string, host: string, owner: { id: string; type: OwnerType }) {
  const ikm = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("rendered-review trial ledger v1") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const subject = `${host.toLowerCase()}\n${owner.type}\n${owner.id}`;
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(subject));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The owner's trial as an entitlement. Starts it (ledger row plus Team entitlement) when the owner
 * never had one; otherwise returns the earlier trial unchanged, restoring its entitlement while it
 * runs (a recreated billing account). Race-safe: the ledger key is unique, so concurrent first
 * opens write one trial. Callers only ask for owners without an entitlement. Any status other than
 * `active` counts as ended.
 */
export async function ownerTrial(db: SqlDatabase, secret: string, host: string, owner: Account) {
  const now = new Date();
  const key = await trialSubjectKey(secret, host, owner);
  const account = await billingAccountFor(db, host, owner);
  await db.run(
    `INSERT INTO trial (subject_key, started_at, expires_at, status, contributor_limit, billing_account_id)
     VALUES (?, ?, ?, 'active', ?, ?) ON CONFLICT (subject_key) DO NOTHING`,
    [
      key,
      now.toISOString(),
      new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString(),
      TRIAL_CONTRIBUTORS,
      account.id,
    ],
  );
  const [trial] = await db.all<{ expiresAt: string; status: string; limit: number }>(
    `SELECT expires_at AS "expiresAt", status, contributor_limit AS "limit" FROM trial WHERE subject_key = ?`,
    [key],
  );
  const { status, limit } = trial!;
  // Converted to a plan or revoked by an operator: ended, whatever the expiry says.
  const expiresAt = status === "active" ? trial!.expiresAt : now.toISOString();
  if (status === "active" && Date.parse(expiresAt) > now.getTime()) {
    await db.run("UPDATE trial SET billing_account_id = ? WHERE subject_key = ?", [account.id, key]);
    await db.run(
      `INSERT INTO entitlement (billing_account_id, plan_id, source, contributor_limit, valid_until, updated_at)
       VALUES (?, 'team', 'trial', ?, ?, ?) ON CONFLICT (billing_account_id) DO NOTHING`,
      [account.id, limit, expiresAt, now.toISOString()],
    );
  } else if (status === "active") {
    await db.run("UPDATE trial SET status = 'expired' WHERE subject_key = ?", [key]);
  }
  return { planId: "team", source: "trial", validUntil: expiresAt } satisfies LocalEntitlement;
}

/**
 * Would this user be one active private contributor too many for the owner's trial in the current
 * billing period? Contributors already counted keep publishing. Counts what publishing records
 * (`activeContributors`), so the trial and the paid plans share one definition of "active".
 */
export async function trialContributorCapReached(db: SqlDatabase, host: string, ownerId: string, userId: string) {
  const [row] = await db.all<{ account: string; limit: number | null; githubUserId: string | null }>(
    `SELECT e.billing_account_id AS "account", e.contributor_limit AS "limit",
       (SELECT a."accountId" FROM account a WHERE a."userId" = ? AND a."providerId" = 'github') AS "githubUserId"
     FROM github_owner o JOIN entitlement e ON e.billing_account_id = o.billing_account_id
     WHERE o.host = ? AND o.github_id = ?`,
    [userId, host, ownerId],
  );
  if (!row || row.limit === null) return false;
  // ponytail: new contributors publishing at the same moment can each pass at count limit - 1 (the
  // tracker records after the GitHub write); accepted, the overshoot is that burst. A reservation
  // row before the write if it matters.
  const { count, contributors } = await activeContributors(db, row.account);
  return !contributors.some((c) => c.githubUserId === row.githubUserId) && count >= row.limit;
}
