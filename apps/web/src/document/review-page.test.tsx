// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The PR review page end to end, with GitHub answered from responses recorded for
// mdn/content#45377 (one modified and one deleted Markdown file, one other file; trees trimmed).
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen";
import { allowedHostsQuery } from "../routes/$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "../routes/__root";
import { MAX_RENDER_CHARS } from "./document";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/fixtures/${name}`, "utf8");
const HEAD = "db23e1ea65fa47a95d8414d2d8be806a26dccf49";
const BASE = "358daf81ac9cf3db999cc8af7aed81ef4ff0c3f6";
const DELETED_BLOB = "d8730ec82103b7ac29d4cdc0bdd9dfd575c49441";
const INDEX = "files/en-us/web/http/reference/status/index.md";
const DELETED = "files/en-us/web/http/reference/status/102/index.md";
const API = "https://api.github.com/repos/mdn/content";

let responses: Record<string, string>;

beforeEach(() => {
  responses = {
    [`${API}/pulls/45377`]: fixture("pull.json"),
    [`${API}/pulls/45377/files?per_page=100`]: fixture("files.json"),
    [`${API}/git/trees/${HEAD}?recursive=1`]: fixture("tree-head.json"),
    [`${API}/git/trees/${BASE}?recursive=1`]: fixture("tree-base.json"),
  };
  for (const oid of [
    "1a05f7e9c35e2bb310563708351758307f34a599",
    "4e1326aa2512d4d8eec8533471eee0dc684de810",
    DELETED_BLOB,
  ])
    responses[`${API}/git/blobs/${oid}`] = fixture(`blob-${oid}.md`);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const body = responses[String(input instanceof Request ? input.url : input)];
    return body === undefined
      ? new Response('{"message":"Not Found"}', { status: 404 })
      : new Response(body, { headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(search = "") {
  // The real root renders <html>; tests mount the page into the test document's body.
  RootRoute.update({ component: Outlet });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(allowedHostsQuery.queryKey, ["github.com"]);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/github.com/mdn/content/pull/45377${search}`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const sidebar = () => screen.getByRole("navigation", { name: "Documents" });
const fileLink = (name: RegExp) => within(sidebar()).getByRole("link", { name });

it("shows the PR in the top bar and lists changed docs with letter statuses", async () => {
  renderPage();
  expect(await screen.findByRole("heading", { level: 1, name: /Remove HTTP status 102 page/ })).toBeTruthy();
  expect(screen.getByText("Merged")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Open in GitHub/ }).getAttribute("href")).toBe(
    "https://github.com/mdn/content/pull/45377",
  );

  const deleted = fileLink(/102\/index\.md, deleted/);
  const modified = fileLink(/status\/index\.md, modified/);
  expect(within(deleted).getByText("D")).toBeTruthy();
  expect(within(deleted).getByText("historical · base revision")).toBeTruthy();
  expect(within(modified).getByText("M")).toBeTruthy();
  // The non-Markdown change links out instead of opening here.
  expect(within(sidebar()).getByText(/1 other file changed/)).toBeTruthy();
});

it("opens the first changed doc; a deleted doc renders read-only from the base revision", async () => {
  renderPage();
  const article = await screen.findByRole("article", { name: "Rendered document" });
  expect(within(article).getByRole("heading", { name: /102 Processing/ })).toBeTruthy();
  expect(fileLink(/102\/index\.md/).getAttribute("aria-current")).toBe("page");
  expect(screen.getByText(/Deleted in this pull request\. Showing the base revision/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Source" }).getAttribute("href")).toBe(
    `https://github.com/mdn/content/blob/${BASE}/${DELETED}`,
  );
});

it("binds the selected doc to the URL and marks changed sections of a modified doc", async () => {
  const router = renderPage();
  await userEvent.click(await screen.findByRole("link", { name: /status\/index\.md, modified/ }));
  expect(router.state.location.search).toMatchObject({ doc: INDEX });

  const article = await screen.findByRole("article", { name: "Rendered document" });
  await vi.waitFor(() => expect(article.querySelectorAll("[data-rr-change]").length).toBeGreaterThan(0));
  // The removed status's entry was edited, so the change shows as a modification.
  expect(article.querySelector('[data-rr-change="modified"]')).toBeTruthy();
  expect(screen.getByRole("note", { name: "Changed-section legend" })).toBeTruthy();
});

it("switches to raw source with GitHub line links, and back, without refetching", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await screen.findByRole("article", { name: "Rendered document" });
  const fetches = vi.mocked(fetch).mock?.calls.length;

  await userEvent.click(screen.getByRole("button", { name: "Raw" }));
  const line1 = screen.getByRole("link", { name: "Line 1 on GitHub" });
  expect(line1.getAttribute("href")).toBe(`https://github.com/mdn/content/blob/${HEAD}/${INDEX}#L1`);
  expect(screen.getByLabelText("Markdown source").textContent).toContain("title: HTTP response status codes");

  await userEvent.click(screen.getByRole("button", { name: "Rendered" }));
  expect(screen.getByRole("article", { name: "Rendered document" })).toBeTruthy();
  expect(vi.mocked(fetch).mock?.calls.length).toBe(fetches);
});

it("lists every head Markdown file under All docs, bound to the files param", async () => {
  const router = renderPage();
  await userEvent.click(await screen.findByRole("button", { name: /All docs/ }));
  expect(router.state.location.search).toMatchObject({ files: "all" });
  expect(await within(sidebar()).findByRole("link", { name: /README\.md, unchanged/ })).toBeTruthy();
  const names = within(sidebar())
    .getAllByRole("link")
    .map((a) => a.getAttribute("title"));
  expect(names).toContain(INDEX);
  expect(names).not.toContain(DELETED); // not in the head tree
  expect(
    within(sidebar())
      .getByRole("button", { name: /All docs/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("moves between files with the arrow keys", async () => {
  renderPage();
  const first = await screen.findByRole("link", { name: /102\/index\.md/ });
  first.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(fileLink(/status\/index\.md, modified/));
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(first);
});

it("shows a size-limit state for documents too large to render, with raw still available", async () => {
  // A fresh blob OID: blobs are cached by OID for the whole test file.
  const huge = "f".repeat(40);
  responses[`${API}/pulls/45377/files?per_page=100`] = fixture("files.json").replace(DELETED_BLOB, huge);
  responses[`${API}/git/blobs/${huge}`] = "x".repeat(MAX_RENDER_CHARS + 1);
  renderPage();
  expect(await screen.findByRole("heading", { name: "This document is too large to render" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "View raw" }));
  expect(screen.getByRole("link", { name: "Line 1 on GitHub" })).toBeTruthy();
});
