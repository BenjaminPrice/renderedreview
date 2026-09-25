// SPDX-License-Identifier: AGPL-3.0-only
// Server only: monthly active private contributors, the hosted service's pricing metric. A GitHub
// user counts once per billing account per billing period when they publish through Rendered Review
// to a private repository.

/**
 * The billing period containing `now`: the calendar month in UTC. The one place periods are decided.
 * ponytail: every account shares the calendar month until subscriptions carry their own period
 * boundaries; then this takes the billing account and reads its subscription's current period.
 */
export function billingPeriod(now: Date): { start: string; end: string } {
  const [y, m] = [now.getUTCFullYear(), now.getUTCMonth()];
  return { start: new Date(Date.UTC(y, m, 1)).toISOString(), end: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
}
