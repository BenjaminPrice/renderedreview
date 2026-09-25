// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Home page PR-link entry and the PR page's non-success states, with GitHub answered by stubs and
// the responses recorded for mdn/content#45377.
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen";
import { browserCache } from "../github/client";
import { expectNewTab } from "../test-utils";
import { allowedHostsQuery } from "./$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "./__root";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/../document/fixtures/${name}`, "utf8");
const API = "https://api.github.com/repos/mdn/content";
const GHES = "ghe.example.com";
// Its own host for the cache test: clients remember an exhausted limit per host.
const CACHED_HOST = "cache.example.com";
const DELETED = "files/en-us/web/http/reference/status/102/index.md";
// Its own host: guests over the app's own limit.
const BUSY_HOST = "busy.example.com";

type Reply = Response | Promise<Response>;
const json = (body: string, init?: ResponseInit) =>
  new Response(body, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
const notFound = () => json('{"message":"Not Found"}', { status: 404 });

// GitHub clients bind `fetch` once per host, so one stub serves the whole file; tests swap the replies.
let reply: (url: string) => Reply | undefined = () => undefined;
const stubGitHub = (fn: typeof reply) => void (reply = fn);

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL) => reply(String(input instanceof Request ? input.url : input)) ?? notFound(),
  );
});

afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  cleanup();
  reply = () => undefined;
});

function renderApp(path: string) {
  RootRoute.update({ component: Outlet });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(allowedHostsQuery.queryKey, {
    hosts: ["github.com", GHES, CACHED_HOST, BUSY_HOST],
    proxyFirst: [],
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("home page", () => {
  const input = () => screen.getByLabelText("GitHub pull request URL");

  async function submit(url: string) {
    const router = renderApp("/");
    await userEvent.type(await screen.findByLabelText("GitHub pull request URL"), url);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return router;
  }

  it("opens a pasted github.com pull request link", async () => {
    stubGitHub(() => undefined);
    const router = await submit("https://github.com/mdn/content/pull/45377/files");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/github.com/mdn/content/pull/45377"));
  });

  it("opens a GitHub Enterprise Server link", async () => {
    stubGitHub(() => undefined);
    const router = await submit(`https://${GHES}/team/handbook/pull/12`);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/${GHES}/team/handbook/pull/12`));
  });

  it("shows no document sidebar or comment rail", async () => {
    renderApp("/");
    await screen.findByLabelText("GitHub pull request URL");
    expect(screen.queryByRole("navigation", { name: "Documents" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: /Comments/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Comments/ })).toBeNull();
  });

  it("explains an invalid link and stays put", async () => {
    const router = await submit("https://gitlab.com/o/r/-/merge_requests/1");
    const error = screen.getByText("That is not a GitHub pull request URL.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")).toBe(error.id);
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("pull request page states", () => {
  const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });

  it("shows loading while GitHub has not answered", async () => {
    stubGitHub(() => new Promise<Response>(() => {}));
    renderApp("/github.com/mdn/content/pull/45377");
    expect(await heading("Loading…")).toBeTruthy();
  });

  it("rejects a malformed pull request link", async () => {
    renderApp("/github.com/mdn/content/pull/not-a-number");
    expect(await heading("Not found")).toBeTruthy();
  });

  it("explains a host this server does not serve", async () => {
    renderApp("/gitlab.example.com/mdn/content/pull/1");
    expect(await heading("Unsupported GitHub host")).toBeTruthy();
    expect(screen.getByText(/gitlab\.example\.com/)).toBeTruthy();
  });

  it("explains a missing or private pull request", async () => {
    stubGitHub(() => undefined);
    renderApp("/github.com/mdn/content/pull/999999");
    expect(await heading("Pull request unavailable")).toBeTruthy();
    expect(screen.getByText(/does not exist or is in a private repository/)).toBeTruthy();
  });

  it("explains a GitHub rate limit", async () => {
    // Own host: the client remembers an exhausted limit per host.
    const reset = Math.floor(Date.now() / 1000) + 3600;
    stubGitHub(() =>
      json('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
    );
    renderApp(`/${GHES}/team/handbook/pull/12`);
    expect(await heading("GitHub rate limit reached")).toBeTruthy();
    expect(screen.getByText(/Try again after/)).toBeTruthy();
    // Inside the app shell, with its way home.
    expect(screen.getByRole("link", { name: "Rendered Review home" })).toBeTruthy();
  });

  it("tells a guest over this app's request limit when to come back, without blaming GitHub", async () => {
    // Direct reads fail (as CORS does), and the app's proxy answers with its own limit.
    stubGitHub((url) =>
      url.startsWith("/api/github/public/")
        ? json(
            JSON.stringify({ code: "rate-limited", message: "Too many requests. Try again shortly.", retryAfter: 90 }),
            { status: 429, headers: { "retry-after": "90" } },
          )
        : Promise.reject(new TypeError("Failed to fetch")),
    );
    renderApp(`/${BUSY_HOST}/team/handbook/pull/12`);
    expect(await heading("Too many requests")).toBeTruthy();
    expect(screen.getByText(/made many requests in a short time\. Try again after \d/)).toBeTruthy();
    expect(screen.queryByText(/GitHub rate limit/)).toBeNull();
  });

  it("keeps showing a recently viewed pull request from the cache when rate-limited", async () => {
    const api = `https://${CACHED_HOST}/api/v3/repos/mdn/content`;
    const responses: Record<string, string> = {
      [`${api}/pulls/45377`]: fixture("pull.json"),
      [`${api}/pulls/45377/files?per_page=100`]: fixture("files.json"),
      [`${api}/pulls/45377/comments?per_page=100`]: fixture("review-comments.json"),
      [`${api}/pulls/45377/reviews?per_page=100`]: fixture("reviews.json"),
      [`${api}/issues/45377/comments?per_page=100`]: fixture("issue-comments.json"),
      [`${api}/git/blobs/d8730ec82103b7ac29d4cdc0bdd9dfd575c49441`]: fixture(
        "blob-d8730ec82103b7ac29d4cdc0bdd9dfd575c49441.md",
      ),
    };
    stubGitHub((url) =>
      responses[url] === undefined ? undefined : json(responses[url], { headers: { etag: '"e"' } }),
    );
    renderApp(`/${CACHED_HOST}/mdn/content/pull/45377?doc=${encodeURIComponent(DELETED)}`);
    await screen.findByRole("article", { name: "Rendered document" });
    cleanup();

    // A reload once the limit is exhausted: a fresh query cache, every GitHub call refused.
    const reset = Math.floor(Date.now() / 1000) + 3600;
    stubGitHub(() =>
      json('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
    );
    renderApp(`/${CACHED_HOST}/mdn/content/pull/45377?doc=${encodeURIComponent(DELETED)}`);
    expect(await screen.findByRole("article", { name: "Rendered document" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: /Remove HTTP status 102 page/ })).toBeTruthy();
    const time = new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(screen.getByText(`GitHub rate limit reached — showing cached data; retry after ${time}.`)).toBeTruthy();
  });

  it("opens the Overview when no Markdown changed, linking to the changes on GitHub", async () => {
    const files = JSON.parse(fixture("files.json")) as { filename: string }[];
    const responses: Record<string, string> = {
      [`${API}/pulls/45377`]: fixture("pull.json"),
      [`${API}/pulls/45377/files?per_page=100`]: JSON.stringify(files.filter((f) => !f.filename.endsWith(".md"))),
    };
    stubGitHub((url) => (responses[url] === undefined ? undefined : json(responses[url])));
    renderApp("/github.com/mdn/content/pull/45377");
    expect(await screen.findByRole("region", { name: "Pull request overview" })).toBeTruthy();
    const sidebar = screen.getByRole("navigation", { name: "Documents" });
    expect(within(sidebar).getByText("No Markdown changed in this pull request.")).toBeTruthy();
    const link = within(sidebar).getByRole("link", { name: "view on GitHub (opens in new tab)" });
    expectNewTab(link);
    expect(link.getAttribute("href")).toBe("https://github.com/mdn/content/pull/45377/files");
  });
});

describe("signed-in and sign-in states", () => {
  const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });
  const USER = "/api/github/user/github.com/repos/mdn/content";
  const signedIn = (user: (url: string) => Reply | undefined) => (url: string) =>
    url === "/api/auth/viewer" ? json('{"login":"octocat","avatarUrl":null}') : user(url);

  it("says private repositories are not supported yet, without rendering their content", async () => {
    const requested: string[] = [];
    stubGitHub(
      signedIn((url) => {
        requested.push(url);
        return json(
          JSON.stringify({ message: "Private repositories aren't supported yet", code: "private-repo-unsupported" }),
          { status: 403 },
        );
      }),
    );
    renderApp("/github.com/mdn/content/pull/45377");
    expect(await heading("Private repositories aren't supported yet")).toBeTruthy();
    expect(requested).toEqual([`${USER}/pulls/45377`]);
  });

  it("says the owner's trial has ended, pointing to the plans, without rendering content", async () => {
    stubGitHub(
      signedIn(() =>
        json(
          JSON.stringify({
            code: "trial-expired",
            message: "The private-repository trial for this owner has ended",
            upgradeUrl: "/pricing",
          }),
          { status: 403 },
        ),
      ),
    );
    renderApp("/github.com/mdn/content/pull/45377");
    const title = await heading("Private-repository trial ended");
    const message = title.parentElement!;
    expect(message.textContent).toMatch(/30-day trial for mdn has ended/);
    expect(message.textContent).toMatch(/Comments already on GitHub are unaffected/);
    const plans = within(message).getByRole("link", { name: "See plans" });
    expect(plans.getAttribute("href")).toBe("/pricing");
    expect(plans.getAttribute("target")).toBeNull();
    expect(message.textContent).not.toMatch(/draft/i);
  });

  it("lists this pull request's stored drafts with Copy on the trial-ended page", async () => {
    const ended = JSON.stringify({
      code: "trial-expired",
      message: "The private-repository trial for this owner has ended",
      upgradeUrl: "/pricing",
      repositoryId: 295774370,
    });
    stubGitHub(signedIn(() => json(ended, { status: 403 })));
    const draft = { id: "d1", path: "docs/intro.md", comment: "Grouped how?", body: "> grouped\n\nGrouped how?" };
    await browserCache.set("drafts", "github.com/295774370/45377", [draft], { private: true });
    renderApp("/github.com/mdn/content/pull/45377");
    const drafts = await screen.findByRole("region", { name: "Unpublished drafts" });
    expect(drafts.textContent).toMatch(/docs\/intro\.md/);
    expect(drafts.textContent).toMatch(/Grouped how\?/);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(within(drafts).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(draft.body);
    await browserCache.clearLocalData();
  });

  it("announces a started trial once and then shows the days left", async () => {
    localStorage.clear();
    const ends = new Date(Date.now() + 23.5 * 86_400_000);
    const files = (JSON.parse(fixture("files.json")) as { filename: string }[]).filter(
      (f) => !f.filename.endsWith(".md"),
    );
    const responses: Record<string, Response> = {
      [`${USER}/pulls/45377`]: json(
        fixture("pull.json").replace(
          '"full_name":"mdn/content","private":false',
          '"full_name":"mdn/content","private":true',
        ),
      ),
      [`${USER}/pulls/45377/files?per_page=100`]: json(JSON.stringify(files)),
      [USER]: json("{}", { headers: { "x-rendered-review-trial-ends": ends.toISOString() } }),
    };
    stubGitHub(signedIn((url) => responses[url]?.clone()));
    renderApp("/github.com/mdn/content/pull/45377");
    const date = ends.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const started = await screen.findByRole("status", { name: "Trial started" });
    expect(started.textContent).toBe(`30-day trial started for mdn · ends ${date}`);
    expect((await screen.findByTitle(`Private-repository trial ends ${date}`)).textContent).toBe(
      "Trial · 24 days left",
    );
    cleanup();

    renderApp("/github.com/mdn/content/pull/45377");
    expect(await screen.findByTitle(`Private-repository trial ends ${date}`)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Trial started" })).toBeNull();
  });

  it("asks the user to sign in again when their GitHub session has expired", async () => {
    stubGitHub(
      signedIn(() => json(JSON.stringify({ message: "Sign in with GitHub again", code: "reauth" }), { status: 401 })),
    );
    renderApp("/github.com/mdn/content/pull/45377");
    const title = await heading("Sign in again");
    expect(within(title.parentElement!).getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("offers sign-in on an anonymous not-found when sign-in is available", async () => {
    stubGitHub((url) => (url === "/api/auth/viewer" ? json("null") : undefined));
    renderApp("/github.com/mdn/content/pull/999998");
    const title = await heading("Pull request unavailable");
    expect(within(title.parentElement!).getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("does not offer sign-in when this deployment has none", async () => {
    stubGitHub(() => undefined);
    renderApp("/github.com/mdn/content/pull/999997");
    const title = await heading("Pull request unavailable");
    expect(within(title.parentElement!).queryByRole("button")).toBeNull();
  });
});

describe("top-bar account", () => {
  const viewer = (body: string) => (url: string) => (url === "/api/auth/viewer" ? json(body) : undefined);

  it("offers GitHub sign-in on the home page when signed out", async () => {
    stubGitHub(viewer("null"));
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  });

  it("shows the signed-in login on a pull request page", async () => {
    const files = JSON.parse(fixture("files.json")) as { filename: string }[];
    const responses: Record<string, string> = {
      "/api/auth/viewer": '{"login":"octocat","avatarUrl":"https://avatars.githubusercontent.com/u/583231?v=4"}',
      // Signed in, reads go through the authenticated endpoint.
      "/api/github/user/github.com/repos/mdn/content/pulls/45377": fixture("pull.json"),
      "/api/github/user/github.com/repos/mdn/content/pulls/45377/files?per_page=100": JSON.stringify(
        files.filter((f) => !f.filename.endsWith(".md")),
      ),
    };
    stubGitHub((url) => (responses[url] === undefined ? undefined : json(responses[url])));
    renderApp("/github.com/mdn/content/pull/45377");
    expect(await screen.findByRole("region", { name: "Pull request overview" })).toBeTruthy();
    expect(await within(screen.getByRole("banner")).findByText("octocat")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
