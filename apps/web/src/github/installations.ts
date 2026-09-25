// SPDX-License-Identifier: AGPL-3.0-only
// Server only: tracks where the GitHub App is installed, from its webhooks, in the control-plane
// tables (owners, installations, repositories and the installation's repository grants). Rows are
// keyed by host plus GitHub's stable numeric IDs, never by login or name, so renames update a row
// instead of forking it. Every handler is an idempotent upsert: a delivery can run more than once.
//
// Ordering: GitHub may deliver events out of order. GitHub never reuses an installation ID, so a
// deleted installation keeps its row as a tombstone (`deleted_at`) and nothing written afterwards
// revives it or grants it repositories: a late `created` stays deleted. Other events carry no
// usable event time, so the last delivery wins; `localInstallation` only trusts the tables where a
// stale row cannot cause a wrong "no" (see there).
//
// Grants are stored for selected-repositories installations only. An all-repositories installation
// covers every repository of its owner, so its grants would say nothing, and writing one per
// repository would make a large organization's delivery run past D1's per-request query limit.
import { log, type LogFields, type SqlDatabase } from "@rendered-review/runtime";
import type { WebhookDelivery, WebhookHandler, WebhookHandlers } from "./webhook";

export interface Account {
  id: string;
  login: string;
  type: "User" | "Organization";
}
interface Installation {
  id: string;
  account: Account;
  selection: "all" | "selected";
  suspendedAt: string | null;
}
interface Repository {
  id: string;
  name: string;
  private: boolean;
}

type Json = Record<string, unknown> | undefined;
const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const githubId = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? String(value) : undefined);
const name = (value: unknown) => (typeof value === "string" && /^[\w.-]{1,100}$/.test(value) ? value : undefined);

function account(value: unknown): Account | undefined {
  const a = obj(value);
  const id = githubId(a?.id);
  const login = name(a?.login);
  const type = a?.type;
  // Enterprise installations own no repositories; the schema has no place for them.
  if (!id || !login || (type !== "User" && type !== "Organization")) return undefined;
  return { id, login, type };
}

/** ISO text for the schema, null when absent, undefined when unparseable. */
function timestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function installation(value: unknown, selectionOverride?: unknown): Installation | undefined {
  const i = obj(value);
  const id = githubId(i?.id);
  const owner = account(i?.account);
  const selection = selectionOverride ?? i?.repository_selection;
  const suspendedAt = timestamp(i?.suspended_at);
  if (!id || !owner || (selection !== "all" && selection !== "selected") || suspendedAt === undefined) return undefined;
  return { id, account: owner, selection, suspendedAt };
}

function repositories(value: unknown): Repository[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const repos: Repository[] = [];
  for (const item of value) {
    const r = obj(item);
    const id = githubId(r?.id);
    const repoName = name(r?.name);
    if (!id || !repoName || typeof r?.private !== "boolean") return undefined;
    repos.push({ id, name: repoName, private: r.private });
  }
  return repos;
}

/** Creates or refreshes the owner row, keyed by host and stable ID: a rename updates its login. */
export function upsertOwner(db: SqlDatabase, host: string, a: Account, now = new Date().toISOString()) {
  return db.run(
    `INSERT INTO github_owner (id, host, github_id, type, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (host, github_id) DO UPDATE SET type = excluded.type, login = excluded.login, updated_at = excluded.updated_at`,
    [crypto.randomUUID(), host, a.id, a.type, a.login, now, now],
  );
}

const OWNER = "(SELECT id FROM github_owner WHERE host = ? AND github_id = ?)";
const INSTALLATION = "(SELECT id FROM github_installation WHERE host = ? AND github_id = ?)";
const REPOSITORY = "(SELECT id FROM github_repository WHERE host = ? AND github_id = ?)";

// No transactions (D1 has none): a handler that fails halfway is completed by GitHub's redelivery.
class Store {
  readonly now = new Date().toISOString();
  constructor(
    readonly db: SqlDatabase,
    readonly host: string,
  ) {}

  owner(a: Account) {
    return upsertOwner(this.db, this.host, a, this.now);
  }

  /** Upserts the installation unless it is a tombstone; true when the row was written. */
  async installation(i: Installation, deletedAt: string | null = null) {
    const { changes } = await this.db.run(
      `INSERT INTO github_installation
         (id, host, github_id, owner_id, repository_selection, suspended_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ${OWNER}, ?, ?, ?, ?, ?)
       ON CONFLICT (host, github_id) DO UPDATE SET owner_id = excluded.owner_id,
         repository_selection = excluded.repository_selection, suspended_at = excluded.suspended_at,
         deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
       WHERE github_installation.deleted_at IS NULL`,
      [
        crypto.randomUUID(),
        this.host,
        i.id,
        this.host,
        i.account.id,
        i.selection,
        i.suspendedAt,
        deletedAt,
        this.now,
        this.now,
      ],
    );
    return changes > 0;
  }

  repository(r: Repository, ownerId: string) {
    return this.db.run(
      `INSERT INTO github_repository (id, host, github_id, owner_id, name, private, created_at, updated_at)
       VALUES (?, ?, ?, ${OWNER}, ?, ?, ?, ?)
       ON CONFLICT (host, github_id) DO UPDATE SET owner_id = excluded.owner_id, name = excluded.name,
         private = excluded.private, updated_at = excluded.updated_at`,
      [crypto.randomUUID(), this.host, r.id, this.host, ownerId, r.name, r.private ? 1 : 0, this.now, this.now],
    );
  }

  async grant(i: Installation, repos: Repository[]) {
    for (const r of repos) {
      await this.repository(r, i.account.id);
      await this.db.run(
        `INSERT INTO github_installation_repository (installation_id, repository_id)
         SELECT i.id, r.id FROM github_installation i, github_repository r
         WHERE i.host = ? AND i.github_id = ? AND i.deleted_at IS NULL AND r.host = ? AND r.github_id = ?
         ON CONFLICT DO NOTHING`,
        [this.host, i.id, this.host, r.id],
      );
    }
  }

  /** Revokes the listed repositories, or every grant without a list. */
  async revoke(installationId: string, repositoryIds?: string[]) {
    if (!repositoryIds) {
      await this.db.run(`DELETE FROM github_installation_repository WHERE installation_id = ${INSTALLATION}`, [
        this.host,
        installationId,
      ]);
      return;
    }
    for (const id of repositoryIds) {
      await this.db.run(
        `DELETE FROM github_installation_repository WHERE installation_id = ${INSTALLATION} AND repository_id = ${REPOSITORY}`,
        [this.host, installationId, this.host, id],
      );
    }
  }
}

type Change = { outcome: "applied" | "stale" | "invalid"; installationId?: string; count?: number };

/** Adds the handler's `github.installation` log line: IDs, event, action, outcome; never payloads or names. */
const logged =
  (apply: (delivery: WebhookDelivery, store: Store) => Promise<Change>): WebhookHandler =>
  async (delivery, { db, config }) => {
    const change = await apply(delivery, new Store(db, new URL(config.github.url).host));
    const fields: LogFields = { githubEvent: delivery.event, action: delivery.action, ...change };
    // An invalid payload is dropped, not retried: GitHub signed it, so a retry would fail the same way.
    (change.outcome === "invalid" ? log.warn : log.info)("github.installation", fields);
  };

const installationIdOf = (payload: Json) => githubId(obj(payload?.installation)?.id);

const onInstallation = logged(async ({ action, payload }, store) => {
  const p = obj(payload);
  const inst = installation(p?.installation);
  const repos = repositories(p?.repositories);
  if (!inst || !repos) return { outcome: "invalid", installationId: installationIdOf(p) };
  await store.owner(inst.account);
  if (action === "deleted") {
    await store.installation(inst, store.now);
    await store.revoke(inst.id);
    return { outcome: "applied", installationId: inst.id };
  }
  if (action === "suspend") inst.suspendedAt ??= store.now;
  if (action === "unsuspend") inst.suspendedAt = null;
  if (!(await store.installation(inst))) return { outcome: "stale", installationId: inst.id };
  if (inst.selection === "all") {
    await store.revoke(inst.id);
    return { outcome: "applied", installationId: inst.id, count: 0 };
  }
  await store.grant(inst, repos);
  return { outcome: "applied", installationId: inst.id, count: repos.length };
});

const onInstallationRepositories = logged(async ({ payload }, store) => {
  const p = obj(payload);
  const inst = installation(p?.installation, p?.repository_selection);
  const added = repositories(p?.repositories_added);
  const removed = repositories(p?.repositories_removed);
  if (!inst || !added || !removed) return { outcome: "invalid", installationId: installationIdOf(p) };
  await store.owner(inst.account);
  if (!(await store.installation(inst))) return { outcome: "stale", installationId: inst.id };
  if (inst.selection === "all") {
    await store.revoke(inst.id);
    return { outcome: "applied", installationId: inst.id, count: 0 };
  }
  // From "all" there are no grants yet: `added` is the new selection.
  await store.grant(inst, added);
  await store.revoke(
    inst.id,
    removed.map((r) => r.id),
  );
  return { outcome: "applied", installationId: inst.id, count: added.length + removed.length };
});

// The account kept its ID; only its login changed.
const onAccountRenamed = logged(async ({ payload }, store) => {
  const p = obj(payload);
  const a = account(p?.account);
  const installationId = installationIdOf(p);
  if (!a) return { outcome: "invalid", installationId };
  await store.db.run("UPDATE github_owner SET login = ?, updated_at = ? WHERE host = ? AND github_id = ?", [
    a.login,
    store.now,
    store.host,
    a.id,
  ]);
  return { outcome: "applied", installationId };
});

// Renamed or transferred: the repository keeps its ID. A transfer can move it to an owner with a
// different plan; re-evaluating entitlement for that belongs to billing, not here.
const onRepositoryMoved = logged(async ({ payload }, store) => {
  const p = obj(payload);
  const r = obj(p?.repository);
  const owner = account(r?.owner);
  const [repo] = repositories([r]) ?? [];
  const installationId = installationIdOf(p);
  if (!owner || !repo) return { outcome: "invalid", installationId };
  await store.owner(owner);
  await store.repository(repo, owner.id);
  return { outcome: "applied", installationId, count: 1 };
});

export const installationHandlers: WebhookHandlers = {
  installation: onInstallation,
  installation_repositories: onInstallationRepositories,
  "installation_target.renamed": onAccountRenamed,
  "repository.renamed": onRepositoryMoved,
  "repository.transferred": onRepositoryMoved,
};

/**
 * Is the app installed on `owner/repo`, according to the webhook-fed tables? `undefined` means the
 * tables cannot say, so the caller must ask GitHub: nothing is known about the owner (webhooks off,
 * or installed before they were on), or a selected-repositories installation has no grant for the
 * repository (its grant list may predate the webhooks, or a rename may not have arrived yet), or
 * every installation known for the owner is deleted (a reinstall's `created` may have been missed).
 * Only a live but suspended installation is a local "no".
 *
 * Stale "yes" is possible: a `removed` delivered before its `added`, or a missed account rename
 * whose old login someone else takes. GitHub then refuses the app token's write, and the user
 * sees that error.
 */
export async function localInstallation(
  db: SqlDatabase,
  host: string,
  owner: string,
  repo: string,
): Promise<boolean | undefined> {
  const rows = await db.all<{ selection: string; suspended: string | null; deleted: string | null; granted: number }>(
    `SELECT i.repository_selection AS selection, i.suspended_at AS suspended, i.deleted_at AS deleted,
       CASE WHEN EXISTS (
         SELECT 1 FROM github_installation_repository ir JOIN github_repository r ON r.id = ir.repository_id
         WHERE ir.installation_id = i.id AND r.owner_id = o.id AND lower(r.name) = lower(?)
       ) THEN 1 ELSE 0 END AS granted
     FROM github_owner o JOIN github_installation i ON i.owner_id = o.id
     WHERE o.host = ? AND lower(o.login) = lower(?)`,
    [repo, host, owner],
  );
  if (rows.length === 0) return undefined;
  const active = rows.filter((row) => !row.deleted && !row.suspended);
  if (active.some((row) => row.selection === "all" || Number(row.granted) === 1)) return true;
  return active.length === 0 && rows.some((row) => !row.deleted) ? false : undefined;
}
