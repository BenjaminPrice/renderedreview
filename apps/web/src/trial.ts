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
import { hmacHex, limited } from "./rate-limit";

export const TRIAL_DAYS = 30;
/** Active private contributors a trial covers; sales-approved trials raise it on the ledger and entitlement. */
export const TRIAL_CONTRIBUTORS = 10;

/** The owner's ledger key, hex. The host is case-insensitive. */
export const trialSubjectKey = (secret: string, host: string, owner: { id: string; type: OwnerType }) =>
  hmacHex(secret, "rendered-review trial ledger v1", `${host.toLowerCase()}\n${owner.type}\n${owner.id}`);

/**
 * The owner's trial as an entitlement. Starts it (ledger row plus Team entitlement) when the owner
 * never had one; otherwise returns the earlier trial unchanged, restoring its entitlement while it
 * runs (a recreated billing account). Race-safe: the ledger key is unique, so concurrent first
 * opens write one trial. Callers only ask for owners without an entitlement. Any status other than
 * `active` counts as ended.
 */
export async function ownerTrial(
  db: SqlDatabase,
  secret: string,
  host: string,
  owner: Account,
  /** Runs only when this call would start a new trial; throws to refuse it (see `countTrialStart`). */
  beforeStart?: () => Promise<void>,
) {
  const now = new Date();
  const key = await trialSubjectKey(secret, host, owner);
  const existing = await db.all("SELECT 1 FROM trial WHERE subject_key = ?", [key]);
  if (!existing.length) await beforeStart?.();
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
 * Counts a trial start against the user and the client address for the current UTC day, and throws
 * `RateLimited` (retry at the next midnight) when either is over `limit`: throwaway organizations
 * cannot each get a trial from one person or one network. Rows are aggregate counters in
 * `usage_counter`; the address is stored only as an HMAC that also covers the day, so days cannot be
 * linked, and earlier days are deleted here.
 */
export async function countTrialStart(
  db: SqlDatabase,
  secret: string,
  limit: number,
  requester: { userId: string; clientAddress?: string },
) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  await db.run("DELETE FROM usage_counter WHERE metric = 'trial-start' AND window_start < ?", [day]);
  const subjects = [["user", requester.userId]];
  if (requester.clientAddress)
    subjects.push([
      "network",
      await hmacHex(secret, "rendered-review trial start v1", `${day}\n${requester.clientAddress}`),
    ]);
  let over = false;
  for (const [scope, subject] of subjects) {
    await db.run(
      `INSERT INTO usage_counter (scope, subject, metric, window_start, count) VALUES (?, ?, 'trial-start', ?, 1)
       ON CONFLICT (scope, subject, metric, window_start) DO UPDATE SET count = usage_counter.count + 1`,
      [scope!, subject!, day],
    );
    const [row] = await db.all<{ count: number }>(
      "SELECT count FROM usage_counter WHERE scope = ? AND subject = ? AND metric = 'trial-start' AND window_start = ?",
      [scope!, subject!, day],
    );
    if (Number(row!.count) > limit) over = true;
  }
  if (over)
    throw limited("trial-start", Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now.getTime()) / 1000));
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
