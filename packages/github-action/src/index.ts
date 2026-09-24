// SPDX-License-Identifier: AGPL-3.0-only

/** Invisible marker identifying the PR-link comment. Rendered Review hides comments carrying it only when the author is the expected bot. */
export const MARKER = "<!-- rendered-review-link:v1 -->";

/** Author of comments created with the default workflow GITHUB_TOKEN. */
export const ACTIONS_BOT = "github-actions[bot]";

const EVENTS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

interface PullFile {
  filename: string;
  previous_filename?: string;
  status: string;
}

interface IssueComment {
  id: number;
  body?: string;
  user: { login: string } | null;
}

export interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: { number: number; draft?: boolean };
}

/** Canonical Rendered Review route: `<base>/<github-host>/<owner>/<repo>/pull/<n>`. */
export function pullRequestUrl(baseUrl: string, serverUrl: string, repository: string, number: number): string {
  return `${baseUrl.replace(/\/+$/, "")}/${new URL(serverUrl).host}/${repository}/pull/${number}`;
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function patterns(value: string): RegExp[] {
  return value
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp);
}

function input(env: Env, name: string): string {
  return env[`INPUT_${name.toUpperCase()}`]?.trim() ?? "";
}

function renderBody(url: string, counts: Record<string, number>): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const detail = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");
  return [
    MARKER,
    `**[Review the rendered Markdown in Rendered Review](${url})**`,
    "",
    `${total} Markdown ${total === 1 ? "file" : "files"} changed (${detail}).`,
  ].join("\n");
}

function bucket(status: string): string {
  if (status === "added" || status === "copied") return "added";
  if (status === "removed") return "deleted";
  if (status === "renamed") return "renamed";
  return "modified";
}

/**
 * Maintains the single PR-link comment. Reads only PR metadata from the GitHub API; never touches PR content.
 * Returns a short description of what happened; throws on API or configuration errors.
 */
export async function run({ env, event, fetch }: { env: Env; event: PullRequestEvent; fetch: Fetch }): Promise<string> {
  if (!event.action || !EVENTS.has(event.action)) return `Skipped: unsupported event action "${event.action}".`;
  const pr = event.pull_request;
  if (!pr) return "Skipped: event has no pull_request.";
  if (pr.draft && input(env, "comment-on-drafts") !== "true") return "Skipped: pull request is a draft.";

  const token = input(env, "github-token");
  if (!token) throw new Error("github-token input is empty.");
  const baseUrl = input(env, "base-url") || "https://renderedreview.dev";
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`base-url must be an http(s) URL, got "${baseUrl}".`);
  const include = patterns(input(env, "include") || "**/*.md\n**/*.markdown");
  const exclude = patterns(input(env, "exclude"));
  const removeWhenEmpty = input(env, "remove-when-empty") !== "false";
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set.");
  const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${apiUrl}/graphql`;

  const request = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(url.startsWith("http") ? url : `${apiUrl}${url}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "rendered-review-action",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${url} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return response.status === 204 ? undefined : response.json();
  };
  const paginate = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const items = (await request("GET", `${path}?per_page=100&page=${page}`)) as T[];
      all.push(...items);
      if (items.length < 100) return all;
    }
  };

  const matches = (path: string | undefined) =>
    path !== undefined && include.some((re) => re.test(path)) && !exclude.some((re) => re.test(path));
  const counts: Record<string, number> = { added: 0, modified: 0, renamed: 0, deleted: 0 };
  for (const file of await paginate<PullFile>(`/repos/${repository}/pulls/${pr.number}/files`)) {
    if (matches(file.filename) || matches(file.previous_filename)) counts[bucket(file.status)]!++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Only comments carrying the marker AND authored by this token's identity are ours to edit or delete.
  // GraphQL reports app identities without the "[bot]" suffix REST uses; "[bot]" logins cannot belong to humans.
  const identity = await viewerLogin(request, graphqlUrl);
  const logins = new Set([identity, identity.endsWith("[bot]") ? identity : `${identity}[bot]`]);
  const comments = await paginate<IssueComment>(`/repos/${repository}/issues/${pr.number}/comments`);
  const own = comments.filter((c) => c.user && logins.has(c.user.login) && c.body?.includes(MARKER));
  const [existing, ...duplicates] = own;
  for (const dup of duplicates) await request("DELETE", `/repos/${repository}/issues/comments/${dup.id}`);

  if (total === 0) {
    if (existing && removeWhenEmpty) {
      await request("DELETE", `/repos/${repository}/issues/comments/${existing.id}`);
      return "Deleted: no matching Markdown files remain.";
    }
    return "No matching Markdown files; nothing to do.";
  }

  const body = renderBody(pullRequestUrl(baseUrl, serverUrl, repository, pr.number), counts);
  if (!existing) {
    await request("POST", `/repos/${repository}/issues/${pr.number}/comments`, { body });
    return `Created comment for ${total} Markdown file(s).`;
  }
  if (existing.body === body) return "Unchanged: comment is up to date.";
  await request("PATCH", `/repos/${repository}/issues/comments/${existing.id}`, { body });
  return `Updated comment for ${total} Markdown file(s).`;
}

/**
 * Login of the token's identity. GraphQL `viewer` resolves user tokens and GitHub App installation tokens;
 * if it is unavailable, fall back to the default GITHUB_TOKEN author.
 */
async function viewerLogin(
  request: (method: string, url: string, body?: unknown) => Promise<unknown>,
  graphqlUrl: string,
): Promise<string> {
  try {
    const result = (await request("POST", graphqlUrl, { query: "{ viewer { login } }" })) as {
      data?: { viewer?: { login?: string } };
    };
    const login = result.data?.viewer?.login;
    if (login) return login;
  } catch {
    // Fall through to the default workflow token identity.
  }
  return ACTIONS_BOT;
}
