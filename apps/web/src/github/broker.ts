// SPDX-License-Identifier: AGPL-3.0-only
// Server only: picks the least-privileged GitHub credential for a repository operation. Tokens it
// returns must never reach the browser or a log.
import type { Identity } from "@rendered-review/identity";

export type GitHubCredential =
  /** The signed-in user's own token: their access, their 5,000/hour limit. */
  | { kind: "user"; token: string }
  /** The operator's public read token. Only valid for public repositories: callers must check. */
  | { kind: "operator"; token: string }
  | { kind: "anonymous" };

export interface RepositoryOperation {
  userId?: string;
  host: string;
  owner: string;
  repo: string;
  // ponytail: reads only; comment/review/resolve arrive with writes.
  operation: "read";
}

/**
 * Viewer reads never use an installation token: an installation alone does not prove the viewer
 * may see the repository.
 */
export async function forRepository(
  { userId, host }: RepositoryOperation,
  deps: {
    identity?: Pick<Identity, "getUserGitHubToken">;
    readToken?: { host: string; token: string };
  },
): Promise<GitHubCredential> {
  const token = userId && (await deps.identity?.getUserGitHubToken(userId, host));
  if (token) return { kind: "user", token };
  if (deps.readToken?.host === host) return { kind: "operator", token: deps.readToken.token };
  return { kind: "anonymous" };
}
