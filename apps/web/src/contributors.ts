// SPDX-License-Identifier: AGPL-3.0-only
// Server only: monthly active private contributors, the hosted service's pricing metric. A GitHub
// user counts once per billing account per billing period when they publish through Rendered Review
// to a private repository.
import { type AppConfig, errorName, log, type SqlDatabase } from "@rendered-review/runtime";
import type { PrivateRepository } from "./billing";

/**
 * The billing period containing `now`: the calendar month in UTC. The one place periods are decided.
 * ponytail: every account shares the calendar month until subscriptions carry their own period
 * boundaries; then this takes the billing account and reads its subscription's current period.
 */
export function billingPeriod(now: Date): { start: string; end: string } {
  const [y, m] = [now.getUTCFullYear(), now.getUTCMonth()];
  return { start: new Date(Date.UTC(y, m, 1)).toISOString(), end: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
}

/** Records the signed-in user as active in a private repository; never throws. */
export type ContributorTracker = (repo: PrivateRepository, userId: string, now?: Date) => Promise<void>;

/**
 * The deployment's contributor tracker: hosted mode only. Community and dedicated deployments have
 * no hosted subscription to meter, so they get none and never touch the billing tables.
 */
export function contributorTrackerFor(config: AppConfig, db: SqlDatabase | undefined): ContributorTracker | undefined {
  if (config.hostingMode !== "hosted" || !db) return undefined;
  return async (repo, userId, now = new Date()) => {
    try {
      // The owner by stable ID (its billing account) and the user by their GitHub account's numeric
      // ID; either missing inserts nothing. The primary key makes repeats and races no-ops.
      await db.run(
        `INSERT INTO active_contributor (billing_account_id, period_start, github_user_id, first_active_at)
         SELECT o.billing_account_id, ?, a."accountId", ?
         FROM github_owner o, "account" a
         WHERE o.host = ? AND o.github_id = ? AND o.billing_account_id IS NOT NULL
           AND a."userId" = ? AND a."providerId" = 'github'
         ON CONFLICT DO NOTHING`,
        [billingPeriod(now).start, now.toISOString(), repo.host, repo.ownerId, userId],
      );
    } catch (error) {
      // Counting must never fail a publish that already landed on GitHub.
      log.warn("billing.contributor", { category: "failed", error: errorName(error) });
    }
  };
}

export interface ActiveContributors {
  periodStart: string;
  periodEnd: string;
  count: number;
  /** `login` is the Rendered Review user's current GitHub login; null once they deleted their account. */
  contributors: { githubUserId: string; login: string | null; firstActiveAt: string }[];
}

/** The billing account's active contributors in the period containing `now`. Callers check the admin role. */
export async function activeContributors(
  db: SqlDatabase,
  billingAccountId: string,
  now = new Date(),
): Promise<ActiveContributors> {
  const { start, end } = billingPeriod(now);
  const contributors = await db.all<ActiveContributors["contributors"][number]>(
    `SELECT c.github_user_id AS "githubUserId", u."name" AS "login", c.first_active_at AS "firstActiveAt"
     FROM active_contributor c
     LEFT JOIN "account" a ON a."providerId" = 'github' AND a."accountId" = c.github_user_id
     LEFT JOIN "user" u ON u."id" = a."userId"
     WHERE c.billing_account_id = ? AND c.period_start = ?
     ORDER BY COALESCE(u."name", ''), c.github_user_id`,
    [billingAccountId, start],
  );
  return { periodStart: start, periodEnd: end, count: contributors.length, contributors };
}
