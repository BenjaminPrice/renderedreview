// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Home page PR-link entry and the PR page's non-success states, with GitHub answered by stubs and
// the responses recorded for mdn/content#45377.
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen";
import { allowedHostsQuery } from "./$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "./__root";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/../document/fixtures/${name}`, "utf8");
const API = "https://api.github.com/repos/mdn/content";
const GHES = "ghe.example.com";

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
  queryClient.setQueryData(allowedHostsQuery.queryKey, { hosts: ["github.com", GHES], proxyFirst: [] });
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
  });

  it("says when no Markdown changed, linking to the changes on GitHub", async () => {
    const files = JSON.parse(fixture("files.json")) as { filename: string }[];
    const responses: Record<string, string> = {
      [`${API}/pulls/45377`]: fixture("pull.json"),
      [`${API}/pulls/45377/files?per_page=100`]: JSON.stringify(files.filter((f) => !f.filename.endsWith(".md"))),
    };
    stubGitHub((url) => (responses[url] === undefined ? undefined : json(responses[url])));
    renderApp("/github.com/mdn/content/pull/45377");
    expect(await screen.findByRole("heading", { name: "No Markdown changed in this pull request" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "review the changes on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/mdn/content/pull/45377/files",
    );
  });
});
