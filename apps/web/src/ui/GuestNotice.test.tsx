// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The PR page's sign-in suggestion for guests, with GitHub answered from responses recorded for
// mdn/content#45377 (non-Markdown files only, so the page opens on the Overview).
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen";
import { allowedHostsQuery } from "../routes/$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "../routes/__root";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/../document/fixtures/${name}`, "utf8");
const files = (JSON.parse(fixture("files.json")) as { filename: string }[]).filter((f) => !f.filename.endsWith(".md"));

type Reply = Response | Promise<Response>;
const json = (body: string, init?: ResponseInit) =>
  new Response(body, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
const notFound = () => json('{"message":"Not Found"}', { status: 404 });

// GitHub clients bind `fetch` once per host, so one stub serves the whole file; tests swap the replies.
// Clients also remember per-host state (observed limits, proxy preference), so each test uses its own host.
let reply: (url: string, init?: RequestInit) => Reply | undefined = () => undefined;

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) =>
      reply(String(input instanceof Request ? input.url : input), init) ?? notFound(),
  );
});

afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  cleanup();
  reply = () => undefined;
  localStorage.clear();
});

interface Serve {
  /** Body of `/api/auth/viewer`; `undefined`: this deployment has no sign-in (404). */
  viewer?: string;
  /** Anonymous rate-limit headers on every GitHub response. */
  quota?: { limit: number; remaining: number; reset: number };
  /** Answer every GitHub call with a rate-limit error instead. */
  limited?: number;
}

const apiBase = (host: string) => (host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`);

function serve(host: string, { viewer = "null", quota, limited }: Serve = {}) {
  const api = `${apiBase(host)}/repos/mdn/content`;
  const responses: Record<string, string> = {
    [`${api}/pulls/45377`]: fixture("pull.json"),
    [`${api}/pulls/45377/files?per_page=100`]: JSON.stringify(files),
    [`${api}/pulls/45377/comments?per_page=100`]: fixture("review-comments.json"),
    [`${api}/pulls/45377/reviews?per_page=100`]: fixture("reviews.json"),
    [`${api}/issues/45377/comments?per_page=100`]: fixture("issue-comments.json"),
  };
  const headers: Record<string, string> = { etag: '"e"' };
  if (quota) {
    headers["x-ratelimit-limit"] = String(quota.limit);
    headers["x-ratelimit-remaining"] = String(quota.remaining);
    headers["x-ratelimit-reset"] = String(quota.reset);
  }
  reply = (url) => {
    if (url === "/api/auth/viewer") return viewer === undefined ? notFound() : json(viewer);
    if (limited)
      return json('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(limited) },
      });
    // Signed in, the authenticated endpoint answers what GitHub would.
    const body = responses[url.replace(`/api/github/user/${host}/`, `${apiBase(host)}/`)];
    return body === undefined ? undefined : json(body, { headers });
  };
}

function renderPr(host: string, { proxyFirst = [] as string[] } = {}) {
  RootRoute.update({ component: Outlet });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(allowedHostsQuery.queryKey, { hosts: [host], proxyFirst });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/${host}/mdn/content/pull/45377`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return screen.findByRole("region", { name: "Pull request overview" });
}

const notice = () => screen.queryByRole("note", { name: "GitHub guest access" });
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const hhmm = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const lowAnnouncement = () =>
  screen.queryAllByRole("status").find((el) => /GitHub guest requests are running low/.test(el.textContent ?? ""));

describe("guest sign-in notice", () => {
  it("suggests signing in to a signed-out guest, quietly", async () => {
    serve("quiet.example.com");
    await renderPr("quiet.example.com");
    const note = notice();
    expect(note?.textContent).toMatch(
      /Reading as a guest — GitHub allows about 60 requests an hour per network\. Sign in with GitHub for 5,000\./,
    );
    expect(within(note!).getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(within(note!).getByRole("button", { name: "Dismiss sign-in suggestion" })).toBeTruthy();
    // Nothing to announce while quiet.
    expect(lowAnnouncement()).toBeUndefined();
  });

  it("is not shown to a signed-in viewer", async () => {
    serve("signed-in.example.com", { viewer: '{"login":"octocat","avatarUrl":null}' });
    await renderPr("signed-in.example.com");
    expect(notice()).toBeNull();
  });

  it("is not shown when this deployment has no sign-in", async () => {
    serve("no-sign-in.example.com", { viewer: undefined });
    await renderPr("no-sign-in.example.com");
    expect(notice()).toBeNull();
  });

  it("is not shown when the host is read through the token-backed proxy", async () => {
    const host = "proxied.example.com";
    serve(host);
    // The proxy answers from the same recorded responses.
    const direct = reply;
    reply = (url, init) => direct(url.replace(`/api/github/public/${host}/`, `${apiBase(host)}/`), init);
    await renderPr(host, { proxyFirst: [host] });
    expect(notice()).toBeNull();
  });

  it("stays dismissed across page loads once dismissed", async () => {
    serve("dismiss.example.com");
    await renderPr("dismiss.example.com");
    await userEvent.click(within(notice()!).getByRole("button", { name: "Dismiss sign-in suggestion" }));
    expect(notice()).toBeNull();
    cleanup();

    await renderPr("dismiss.example.com");
    expect(notice()).toBeNull();
  });

  it("warns when few anonymous requests are left, even after dismissal", async () => {
    const reset = inAnHour();
    serve("low.example.com");
    await renderPr("low.example.com");
    await userEvent.click(within(notice()!).getByRole("button", { name: "Dismiss sign-in suggestion" }));
    cleanup();

    serve("low.example.com", { quota: { limit: 60, remaining: 10, reset } });
    await renderPr("low.example.com");
    const note = await screen.findByRole("note", { name: "GitHub guest access" });
    expect(note.textContent).toMatch(`10 requests left until ${hhmm(reset)}`);
    expect(within(note).getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    // Not dismissible while low; announced once, politely.
    expect(within(note).queryByRole("button", { name: "Dismiss sign-in suggestion" })).toBeNull();
    expect(lowAnnouncement()).toBeTruthy();
  });

  it("stays quiet while plenty of anonymous requests are left", async () => {
    serve("plenty.example.com", { quota: { limit: 60, remaining: 40, reset: inAnHour() } });
    await renderPr("plenty.example.com");
    expect(notice()?.textContent).not.toMatch(/requests left/);
    expect(lowAnnouncement()).toBeUndefined();
  });

  it("starts sign-in from the notice, returning to the same URL", async () => {
    const path = "/sign-in.example.com/mdn/content/pull/45377";
    history.replaceState(null, "", `${path}?doc=a.md#L3`);
    serve("sign-in.example.com");
    const served = reply;
    const posts: { url: string; body: unknown }[] = [];
    reply = (url, init) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
      return url === "/api/auth/sign-in/social" ? json("{}") : served(url, init);
    };
    await renderPr("sign-in.example.com");
    await userEvent.click(within(notice()!).getByRole("button", { name: "Sign in with GitHub" }));
    expect(posts).toEqual([
      { url: "/api/auth/sign-in/social", body: { provider: "github", callbackURL: `${path}?doc=a.md#L3` } },
    ]);
  });

  // Last: the full rate-limit banner's state is page-wide and would hide the notice in later tests.
  it("gives way to the rate-limit banner once the limit is reached", async () => {
    const host = "limited.example.com";
    serve(host);
    await renderPr(host);
    cleanup();

    // A reload once the limit is exhausted: cached data, with the banner saying so.
    const reset = inAnHour();
    serve(host, { limited: reset });
    await renderPr(host);
    expect(screen.getByText(`GitHub rate limit reached — showing cached data; retry after ${hhmm(reset)}.`)).toBeTruthy();
    expect(notice()).toBeNull();
    expect(lowAnnouncement()).toBeUndefined();
  });
});
