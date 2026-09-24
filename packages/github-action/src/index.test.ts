// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { MARKER, globToRegExp, pullRequestUrl, run, type PullRequestEvent } from "./index";

interface Comment {
  id: number;
  body: string;
  user: { login: string };
}

/** In-memory GitHub API: files and comments for PR acme/widgets#7. */
function github({
  files = [] as object[],
  comments = [] as Comment[],
  viewer = null as string | null,
  api = "https://api.github.com",
} = {}) {
  const calls: string[] = [];
  let nextId = 1000;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = <T>(items: T[]) => items.slice((page - 1) * 100, page * 100);
    calls.push(`${method} ${url.pathname}${url.search}`);
    expect(url.origin + "/").toBe(new URL(api).origin + "/");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t0ken");
    const path = url.pathname.replace(new URL(api).pathname.replace(/\/$/, ""), "");

    if (path === "/graphql")
      return viewer ? json({ data: { viewer: { login: viewer } } }) : json({ message: "no" }, 403);
    if (method === "GET" && path === "/repos/acme/widgets/pulls/7/files") return json(slice(files));
    if (method === "GET" && path === "/repos/acme/widgets/issues/7/comments") return json(slice(comments));
    if (method === "POST" && path === "/repos/acme/widgets/issues/7/comments") {
      const comment = { id: nextId++, body: body.body, user: { login: viewer ?? "github-actions[bot]" } };
      comments.push(comment);
      return json(comment, 201);
    }
    const match = path.match(/^\/repos\/acme\/widgets\/issues\/comments\/(\d+)$/);
    const index = comments.findIndex((c) => c.id === Number(match?.[1]));
    if (match && index >= 0 && method === "PATCH") {
      comments[index]!.body = body.body;
      return json(comments[index]);
    }
    if (match && index >= 0 && method === "DELETE") {
      comments.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, comments };
}

const env = (extra: Record<string, string> = {}) => ({
  "INPUT_GITHUB-TOKEN": "t0ken",
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com",
  ...extra,
});
const event = (action = "opened", draft = false): PullRequestEvent => ({ action, pull_request: { number: 7, draft } });
const md = (filename: string, status = "modified") => ({ filename, status });
const writes = (calls: string[]) => calls.filter((c) => !c.startsWith("GET") && !c.includes("graphql"));

describe("run", () => {
  it("creates one comment, then no-ops, then updates as files change", async () => {
    const gh = github({ files: [md("README.md", "added"), md("src/app.ts")] });
    expect(await run({ env: env(), event: event(), fetch: gh.fetch })).toMatch(/^Created/);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain(MARKER);
    expect(gh.comments[0]!.body).toContain("https://renderedreview.dev/github.com/acme/widgets/pull/7");
    expect(gh.comments[0]!.body).toContain("1 Markdown file changed (1 added)");

    expect(await run({ env: env(), event: event("synchronize"), fetch: gh.fetch })).toMatch(/^Unchanged/);
    gh.calls.length = 0;
    expect(await run({ env: env(), event: event("reopened"), fetch: gh.fetch })).toMatch(/^Unchanged/);
    expect(writes(gh.calls)).toEqual([]);
  });

  it("updates the existing comment and removes duplicates of its own", async () => {
    const own = (id: number) => ({ id, body: `${MARKER}\nold`, user: { login: "github-actions[bot]" } });
    const gh = github({ files: [md("docs/a.md"), md("docs/b.markdown")], comments: [own(1), own(2)] });
    expect(await run({ env: env(), event: event("synchronize"), fetch: gh.fetch })).toMatch(/^Updated/);
    expect(gh.comments.map((c) => c.id)).toEqual([1]);
    expect(gh.comments[0]!.body).toContain("2 Markdown files changed (2 modified)");
  });

  it("links pull requests that only change MDX files", async () => {
    const gh = github({ files: [md("docs/intro.mdx", "added"), md("src/app.ts")] });
    expect(await run({ env: env(), event: event(), fetch: gh.fetch })).toMatch(/^Created/);
    expect(gh.comments[0]!.body).toContain("1 Markdown file changed (1 added)");
  });

  it("deletes its own comment when Markdown disappears, unless remove-when-empty is false", async () => {
    const comments = () => [{ id: 1, body: `${MARKER}\nold`, user: { login: "github-actions[bot]" } }];
    const gh = github({ files: [md("src/app.ts")], comments: comments() });
    expect(await run({ env: env(), event: event("synchronize"), fetch: gh.fetch })).toMatch(/^Deleted/);
    expect(gh.comments).toEqual([]);

    const kept = github({ files: [md("src/app.ts")], comments: comments() });
    await run({ env: env({ "INPUT_REMOVE-WHEN-EMPTY": "false" }), event: event("synchronize"), fetch: kept.fetch });
    expect(kept.comments).toHaveLength(1);
  });

  it("never edits a human or unknown bot comment containing the marker", async () => {
    const human = { id: 1, body: `quoting ${MARKER}`, user: { login: "alice" } };
    const otherBot = { id: 2, body: `${MARKER}\nfake`, user: { login: "evil[bot]" } };
    const gh = github({ files: [md("README.md")], comments: [human, otherBot] });
    expect(await run({ env: env(), event: event(), fetch: gh.fetch })).toMatch(/^Created/);
    expect(gh.comments.slice(0, 2)).toEqual([
      { id: 1, body: `quoting ${MARKER}`, user: { login: "alice" } },
      { id: 2, body: `${MARKER}\nfake`, user: { login: "evil[bot]" } },
    ]);
    expect(writes(gh.calls)).toEqual(["POST /repos/acme/widgets/issues/7/comments"]);

    const empty = github({ files: [], comments: [human, otherBot] });
    await run({ env: env(), event: event(), fetch: empty.fetch });
    expect(empty.comments).toHaveLength(2);
  });

  it("recognises app-token comments via the GraphQL viewer identity", async () => {
    const gh = github({
      files: [md("README.md")],
      viewer: "my-app",
      comments: [{ id: 1, body: `${MARKER}\nold`, user: { login: "my-app[bot]" } }],
    });
    expect(await run({ env: env(), event: event(), fetch: gh.fetch })).toMatch(/^Updated/);
  });

  it("skips drafts unless comment-on-drafts, and ignores other actions", async () => {
    const gh = github({ files: [md("README.md")] });
    expect(await run({ env: env(), event: event("opened", true), fetch: gh.fetch })).toMatch(/draft/);
    expect(await run({ env: env(), event: event("closed"), fetch: gh.fetch })).toMatch(/unsupported/);
    expect(gh.calls).toEqual([]);
    const drafts = env({ "INPUT_COMMENT-ON-DRAFTS": "true" });
    expect(await run({ env: drafts, event: event("opened", true), fetch: gh.fetch })).toMatch(/^Created/);
  });

  it("paginates changed files", async () => {
    const files = [...Array.from({ length: 150 }, (_, i) => md(`src/f${i}.ts`)), md("late.md")];
    const gh = github({ files });
    expect(await run({ env: env(), event: event(), fetch: gh.fetch })).toMatch(/^Created/);
    expect(gh.calls).toContain("GET /repos/acme/widgets/pulls/7/files?per_page=100&page=2");
  });

  it("counts renamed (either path) and deleted files, honouring exclude", async () => {
    const gh = github({
      files: [
        { filename: "notes.txt", previous_filename: "notes.md", status: "renamed" },
        md("old.md", "removed"),
        md("vendor/x.md", "added"),
      ],
    });
    await run({ env: env({ INPUT_EXCLUDE: "vendor/**" }), event: event(), fetch: gh.fetch });
    expect(gh.comments[0]!.body).toContain("2 Markdown files changed (1 renamed, 1 deleted)");
  });

  it("uses GHES server and API URLs", async () => {
    const api = "https://ghe.example.com/api/v3";
    const gh = github({ files: [md("README.md")], api });
    const ghes = env({
      GITHUB_SERVER_URL: "https://ghe.example.com",
      GITHUB_API_URL: api,
      "INPUT_BASE-URL": "https://review.example.com/",
    });
    await run({ env: ghes, event: event(), fetch: gh.fetch });
    expect(gh.comments[0]!.body).toContain("https://review.example.com/ghe.example.com/acme/widgets/pull/7");
    expect(gh.calls[0]).toBe("GET /api/v3/repos/acme/widgets/pulls/7/files?per_page=100&page=1");
  });

  it("throws on API errors so the entry point can warn", async () => {
    const gh = github({ files: [md("README.md")] });
    await expect(
      run({ env: { ...env(), GITHUB_REPOSITORY: "acme/nope" }, event: event(), fetch: gh.fetch }),
    ).rejects.toThrow(/404/);
  });
});

describe("globToRegExp", () => {
  it("matches globstar, star and question mark", () => {
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false);
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("?.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("amd")).toBe(false);
  });
});

it("pullRequestUrl builds the canonical route", () => {
  expect(pullRequestUrl("https://renderedreview.dev", "https://github.com", "acme/widgets", 123)).toBe(
    "https://renderedreview.dev/github.com/acme/widgets/pull/123",
  );
});
