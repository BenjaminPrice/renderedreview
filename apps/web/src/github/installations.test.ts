// SPDX-License-Identifier: AGPL-3.0-only
// GitHub App installation tracking: webhook deliveries (trimmed from GitHub's documented payloads)
// run through the real receiver into the control-plane database, on SQLite and PostgreSQL.
import { createHmac } from "node:crypto";
import { migrate } from "@rendered-review/control-plane";
import { loadConfig, type RequestContext, type SqlDatabase } from "@rendered-review/runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localInstallation } from "./installations";
import { testDatabases } from "./test-databases";
import { receiveWebhook } from "./webhook";

const SECRET = "webhook-secret";
const config = loadConfig({
  HOSTING_MODE: "community",
  ACCESS_POLICY: "installed",
  GITHUB_APP_ID: "1",
  GITHUB_APP_CLIENT_ID: "Iv23.app-client",
  GITHUB_APP_CLIENT_SECRET: "app-client-secret",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: SECRET,
  ENCRYPTION_KEY: btoa("k".repeat(32)),
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-32-chars!",
  DATABASE_URL: "sqlite::memory:",
});

const acme = { login: "acme", id: 100, type: "Organization", site_admin: false };
const octo = { login: "octo", id: 200, type: "User", site_admin: false };
const widgets = { id: 1001, node_id: "R_1", name: "widgets", full_name: "acme/widgets", private: true };
const gadgets = { id: 1002, node_id: "R_2", name: "gadgets", full_name: "acme/gadgets", private: false };

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    account: acme,
    repository_selection: "selected",
    permissions: { metadata: "read", contents: "read", pull_requests: "write", issues: "write" },
    events: ["pull_request"],
    created_at: "2026-09-24T12:00:00.000Z",
    updated_at: "2026-09-24T12:00:00.000Z",
    suspended_at: null,
    ...overrides,
  };
}

let deliveries = 0;
async function deliver(context: RequestContext, event: string, payload: object) {
  const body = JSON.stringify(payload);
  const res = await receiveWebhook(
    new Request("https://rr.example/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": `inst-${++deliveries}`,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
      body,
    }),
    context,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { outcome: string };
}

const noScheduler = { waitUntil: () => {} };
const noSecrets = { get: async () => undefined };

describe.each(testDatabases)("installation tracking on %s", (_, open) => {
  let db: SqlDatabase;
  let close: () => Promise<void>;
  let context: RequestContext;

  const state = async () => ({
    owners: await db.all("SELECT github_id, login, type FROM github_owner ORDER BY github_id"),
    installations: await db.all(
      `SELECT i.github_id, o.github_id AS owner, i.repository_selection, i.suspended_at, i.deleted_at
       FROM github_installation i JOIN github_owner o ON o.id = i.owner_id ORDER BY i.github_id`,
    ),
    repositories: await db.all(
      `SELECT r.github_id, o.github_id AS owner, r.name, r.private
       FROM github_repository r JOIN github_owner o ON o.id = r.owner_id ORDER BY r.github_id`,
    ),
    grants: (
      await db.all<{ installation: string; repository: string }>(
        `SELECT i.github_id AS installation, r.github_id AS repository FROM github_installation_repository ir
         JOIN github_installation i ON i.id = ir.installation_id JOIN github_repository r ON r.id = ir.repository_id
         ORDER BY r.github_id`,
      )
    ).map((g) => `${g.installation}:${g.repository}`),
  });
  const send = (event: string, payload: object) => deliver(context, event, payload);
  const created = (inst = installation(), repositories = [widgets]) =>
    send("installation", { action: "created", installation: inst, repositories, sender: octo });

  beforeAll(async () => {
    ({ db, close } = await open());
    await migrate(db);
    context = { config, secrets: noSecrets, scheduler: noScheduler, db };
  });
  afterAll(() => close?.());
  beforeEach(async () => {
    for (const table of ["github_installation_repository", "github_repository", "github_installation", "github_owner"])
      await db.run(`DELETE FROM ${table}`);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe("installation", () => {
    it("created stores the owner, installation, repositories and their grants", async () => {
      expect(await created(installation(), [widgets, gadgets])).toEqual({ outcome: "accepted" });
      expect(await state()).toEqual({
        owners: [{ github_id: "100", login: "acme", type: "Organization" }],
        installations: [
          { github_id: "42", owner: "100", repository_selection: "selected", suspended_at: null, deleted_at: null },
        ],
        repositories: [
          { github_id: "1001", owner: "100", name: "widgets", private: 1 },
          { github_id: "1002", owner: "100", name: "gadgets", private: 0 },
        ],
        grants: ["42:1001", "42:1002"],
      });
    });

    it("is idempotent: a rerun of created leaves the same rows", async () => {
      await created();
      const first = await state();
      await created();
      expect(await state()).toEqual(first);
    });

    it("deleted keeps a tombstone and removes the grants", async () => {
      await created();
      await send("installation", { action: "deleted", installation: installation(), repositories: [widgets] });
      const after = await state();
      expect(after.installations).toEqual([
        expect.objectContaining({ github_id: "42", deleted_at: expect.any(String) }),
      ]);
      expect(after.grants).toEqual([]);
    });

    it("a created delivered after its deleted does not bring the installation back", async () => {
      await send("installation", { action: "deleted", installation: installation(), repositories: [widgets] });
      expect(await created()).toEqual({ outcome: "accepted" });
      const after = await state();
      expect(after.installations).toEqual([
        expect.objectContaining({ github_id: "42", deleted_at: expect.any(String) }),
      ]);
      expect(after.grants).toEqual([]);
      // Nor does a late repositories change.
      await send("installation_repositories", {
        action: "added",
        installation: installation(),
        repository_selection: "selected",
        repositories_added: [gadgets],
        repositories_removed: [],
      });
      expect((await state()).grants).toEqual([]);
    });

    it("suspend and unsuspend record and clear suspended_at", async () => {
      await created();
      await send("installation", {
        action: "suspend",
        installation: installation({ suspended_at: "2026-09-25T08:00:00Z" }),
      });
      expect((await state()).installations).toEqual([
        expect.objectContaining({ suspended_at: "2026-09-25T08:00:00.000Z" }),
      ]);
      await send("installation", { action: "unsuspend", installation: installation() });
      expect((await state()).installations).toEqual([expect.objectContaining({ suspended_at: null })]);
    });

    it("new_permissions_accepted refreshes the installation", async () => {
      await created();
      await send("installation", {
        action: "new_permissions_accepted",
        installation: installation({ repository_selection: "all" }),
      });
      expect((await state()).installations).toEqual([expect.objectContaining({ repository_selection: "all" })]);
    });

    it("ignores a malformed payload without failing the delivery", async () => {
      expect(await send("installation", { action: "created", installation: { id: "nope" } })).toEqual({
        outcome: "accepted",
      });
      expect((await state()).installations).toEqual([]);
    });
  });

  describe("installation_repositories", () => {
    const change = (added: object[], removed: object[], selection = "selected") =>
      send("installation_repositories", {
        action: added.length ? "added" : "removed",
        installation: installation({ repository_selection: selection }),
        repository_selection: selection,
        repositories_added: added,
        repositories_removed: removed,
      });

    it("added grants the repositories, idempotently", async () => {
      await created();
      await change([gadgets], []);
      await change([gadgets], []);
      expect((await state()).grants).toEqual(["42:1001", "42:1002"]);
    });

    it("removed revokes the repositories, idempotently", async () => {
      await created(installation(), [widgets, gadgets]);
      await change([], [widgets]);
      await change([], [widgets]);
      expect((await state()).grants).toEqual(["42:1002"]);
    });

    it("records an installation first seen through a repositories change", async () => {
      await change([gadgets], []);
      const after = await state();
      expect(after.installations).toEqual([expect.objectContaining({ github_id: "42", owner: "100" })]);
      expect(after.grants).toEqual(["42:1002"]);
    });

    it("switching from all to selected stores the new selection", async () => {
      await created(installation({ repository_selection: "all" }), [widgets, gadgets]);
      await change([gadgets], [], "selected");
      const after = await state();
      expect(after.installations).toEqual([expect.objectContaining({ repository_selection: "selected" })]);
      expect(after.grants).toEqual(["42:1002"]);
    });

    it("switching from selected to all clears the grants", async () => {
      await created();
      await change([gadgets], [], "all");
      const after = await state();
      expect(after.installations).toEqual([expect.objectContaining({ repository_selection: "all" })]);
      expect(after.grants).toEqual([]);
    });
  });

  describe("all-repositories installations", () => {
    it("store no per-repository grants, so a large installation costs the same few queries", async () => {
      const queries = async (count: number) => {
        await db.run("DELETE FROM github_installation");
        let n = 0;
        const counting: SqlDatabase = {
          all: (sql, params) => (n++, db.all(sql, params)),
          run: (sql, params) => (n++, db.run(sql, params)),
        };
        const repos = Array.from({ length: count }, (_, i) => ({ ...widgets, id: 5000 + i, name: `repo-${i}` }));
        await deliver({ ...context, db: counting }, "installation", {
          action: "created",
          installation: installation({ repository_selection: "all" }),
          repositories: repos,
        });
        return n;
      };
      expect(await queries(50)).toBe(await queries(2));
      expect((await state()).grants).toEqual([]);
    });
  });

  describe("renames and transfers", () => {
    it("installation_target renamed updates the owner's login only", async () => {
      await created();
      await send("installation_target", {
        action: "renamed",
        account: { ...acme, login: "acme-corp" },
        changes: { login: { from: "acme" } },
        target_type: "Organization",
        installation: { id: 42 },
      });
      expect((await state()).owners).toEqual([{ github_id: "100", login: "acme-corp", type: "Organization" }]);
    });

    it("repository renamed updates the name, keyed by ID", async () => {
      await created();
      await send("repository", {
        action: "renamed",
        changes: { repository: { name: { from: "widgets" } } },
        repository: { ...widgets, name: "sprockets", full_name: "acme/sprockets", owner: acme },
        installation: { id: 42 },
      });
      expect((await state()).repositories).toEqual([
        { github_id: "1001", owner: "100", name: "sprockets", private: 1 },
      ]);
    });

    it("repository transferred moves it to the new owner", async () => {
      await created();
      await send("repository", {
        action: "transferred",
        changes: { owner: { from: { organization: acme } } },
        repository: { ...widgets, full_name: "octo/widgets", owner: octo },
        installation: { id: 42 },
      });
      const after = await state();
      expect(after.owners).toEqual([
        { github_id: "100", login: "acme", type: "Organization" },
        { github_id: "200", login: "octo", type: "User" },
      ]);
      expect(after.repositories).toEqual([{ github_id: "1001", owner: "200", name: "widgets", private: 1 }]);
    });
  });

  describe("localInstallation", () => {
    const check = (owner: string, repo: string) => localInstallation(db, "github.com", owner, repo);

    it("is unknown for an owner the database has never seen an installation for", async () => {
      expect(await check("acme", "widgets")).toBeUndefined();
    });

    it("is installed on a granted repository, matching names case-insensitively", async () => {
      await created();
      expect(await check("ACME", "Widgets")).toBe(true);
    });

    it("is unknown, not false, for a repository a selected installation has no grant for", async () => {
      // The grant list may predate the webhook, so only GitHub can say no.
      await created();
      expect(await check("acme", "gadgets")).toBeUndefined();
    });

    it("is installed on every repository of an all-repositories installation", async () => {
      await created(installation({ repository_selection: "all" }), []);
      expect(await check("acme", "anything")).toBe(true);
    });

    it("is not installed while the owner's only live installation is suspended", async () => {
      await created(installation({ suspended_at: "2026-09-25T08:00:00Z" }));
      expect(await check("acme", "widgets")).toBe(false);
    });

    it("is unknown once every installation it knows for the owner is deleted, since a reinstall may have been missed", async () => {
      await created();
      await send("installation", { action: "deleted", installation: installation() });
      expect(await check("acme", "widgets")).toBeUndefined();
    });

    it("does not count a grant for a repository that moved to another owner", async () => {
      await created();
      await send("repository", {
        action: "transferred",
        repository: { ...widgets, owner: octo },
        installation: { id: 42 },
      });
      expect(await check("acme", "widgets")).toBeUndefined();
      expect(await check("octo", "widgets")).toBeUndefined();
    });
  });

  it("logs one github.installation event per change, without payloads or names", async () => {
    await created();
    const lines = vi
      .mocked(console.info)
      .mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
      .filter((e) => e.event === "github.installation");
    expect(lines).toEqual([
      {
        level: "info",
        event: "github.installation",
        installationId: "42",
        githubEvent: "installation",
        action: "created",
        outcome: "applied",
        count: 1,
      },
    ]);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/acme|widgets/);
  });
});
