// SPDX-License-Identifier: AGPL-3.0-only
// Server only: picks the least-privileged GitHub credential for a repository operation. Tokens it
// returns must never reach the browser or a log.
import type { Identity } from "@rendered-review/identity";
import type { InstallationCheck } from "./installation";
import { repoVisibility } from "./proxy";

export type GitHubCredential =
  /** The signed-in user's own token: their access, their 5,000/hour limit. */
  | { kind: "user"; token: string }
  /** The operator's public read token. Only valid for public repositories: callers must check. */
  | { kind: "operator"; token: string }
  | { kind: "anonymous" };

export type WriteCredential =
  /** The user's GitHub App token: the app is installed on the repository. */
  | { kind: "user"; token: string }
  /** The user's OAuth App token (`public_repo`): a public repository without the app. */
  | { kind: "public-oauth"; token: string }
  /** Public repository, app not installed, OAuth App not linked: offer `authorizePublicComments`. */
  | { kind: "needs-public-authorization" }
  | { kind: "private-repo-unsupported" }
  /** No usable GitHub App token (signed out elsewhere, refresh rejected): sign in again. */
  | { kind: "reauth" }
  /** GitHub would not show the repository to the user (for example 404, 403). */
  | { kind: "unavailable"; status: number };

interface Repository {
  host: string;
  owner: string;
  repo: string;
}
export type ReadOperation = Repository & { userId?: string; operation: "read" };
export type WriteOperation = Repository & { userId: string; operation: "comment" | "review" | "resolve" };
export type RepositoryOperation = ReadOperation | WriteOperation;

interface BrokerDeps {
  /** Writes need `getUserPublicWriteToken` too; reads do not. */
  identity?: Pick<Identity, "getUserGitHubToken"> & Partial<Pick<Identity, "getUserPublicWriteToken">>;
  readToken?: { host: string; token: string };
  /** Undefined without a GitHub App private key: the app then counts as not installed. */
  installed?: InstallationCheck;
  fetch?: typeof fetch;
}

/**
 * Viewer reads never use an installation token: an installation alone does not prove the viewer
 * may see the repository. Writes use the GitHub App user token where the app is installed (a GitHub
 * App user token can only act where its app is installed), else the OAuth App token on public
 * repositories.
 */
export async function forRepository(op: ReadOperation, deps: BrokerDeps): Promise<GitHubCredential>;
export async function forRepository(op: WriteOperation, deps: BrokerDeps): Promise<WriteCredential>;
export async function forRepository(
  op: RepositoryOperation,
  deps: BrokerDeps,
): Promise<GitHubCredential | WriteCredential> {
  const { userId, host } = op;
  const token = userId && (await deps.identity?.getUserGitHubToken(userId, host));
  if (op.operation === "read") {
    if (token) return { kind: "user", token };
    if (deps.readToken?.host === host) return { kind: "operator", token: deps.readToken.token };
    return { kind: "anonymous" };
  }

  if (!token) return { kind: "reauth" };
  const visibility = await repoVisibility(
    host,
    `repos/${op.owner}/${op.repo}`,
    { Authorization: `Bearer ${token}`, "User-Agent": "rendered-review", "X-GitHub-Api-Version": "2022-11-28" },
    deps.fetch ?? fetch,
  );
  if (visibility instanceof Response) {
    return visibility.status === 401 ? { kind: "reauth" } : { kind: "unavailable", status: visibility.status };
  }
  // Private repositories need an entitlement check before anything is served or written.
  if (visibility === "private") return { kind: "private-repo-unsupported" };
  if (await deps.installed?.(host, op.owner, op.repo)) return { kind: "user", token };
  const publicToken = await deps.identity?.getUserPublicWriteToken?.(op.userId, host);
  return publicToken ? { kind: "public-oauth", token: publicToken } : { kind: "needs-public-authorization" };
}
