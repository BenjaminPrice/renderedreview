// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The PR review page end to end, with GitHub answered from responses recorded for
// mdn/content#45377 (one modified and one deleted Markdown file, one other file; trees trimmed;
// review comments, reviews and conversation trimmed to the fields read).
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
/** Every URL fetched. GitHub clients keep the first stubbed fetch, so it records into this shared list. */
const requested: string[] = [];

beforeEach(() => {
  requested.length = 0;
  responses = {
    [`${API}/pulls/45377`]: fixture("pull.json"),
    [`${API}/pulls/45377/files?per_page=100`]: fixture("files.json"),
    [`${API}/git/trees/${HEAD}?recursive=1`]: fixture("tree-head.json"),
    [`${API}/git/trees/${BASE}?recursive=1`]: fixture("tree-base.json"),
    [`${API}/pulls/45377/comments?per_page=100`]: fixture("review-comments.json"),
    [`${API}/pulls/45377/reviews?per_page=100`]: fixture("reviews.json"),
    [`${API}/issues/45377/comments?per_page=100`]: fixture("issue-comments.json"),
  };
  for (const oid of [
    "1a05f7e9c35e2bb310563708351758307f34a599",
    "4e1326aa2512d4d8eec8533471eee0dc684de810",
    DELETED_BLOB,
  ])
    responses[`${API}/git/blobs/${oid}`] = fixture(`blob-${oid}.md`);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const body = responses[url];
    return body === undefined
      ? new Response('{"message":"Not Found"}', { status: 404 })
      : new Response(body, { headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.rail;
});

function renderPage(search = "") {
  // The real root renders <html>; tests mount the page into the test document's body.
  RootRoute.update({ component: Outlet });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(allowedHostsQuery.queryKey, { hosts: ["github.com"], proxyFirst: [] });
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

it("scrolls the document back to the top when another doc is opened", async () => {
  renderPage();
  await screen.findByRole("article", { name: "Rendered document" });
  const scroller = document.querySelector<HTMLElement>(".rr-scroll")!;
  scroller.scrollTop = 500;
  expect(scroller.scrollTop).toBe(500);

  await userEvent.click(fileLink(/status\/index\.md, modified/));
  await screen.findByRole("heading", { name: /HTTP response status codes/ });
  expect(scroller.scrollTop).toBe(0);
});

it("switches to raw source with GitHub line links, and back, without refetching", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await screen.findByRole("article", { name: "Rendered document" });
  const fetches = requested.length;

  await userEvent.click(screen.getByRole("button", { name: "Raw" }));
  const line1 = screen.getByRole("link", { name: "Line 1 on GitHub" });
  expect(line1.getAttribute("href")).toBe(`https://github.com/mdn/content/blob/${HEAD}/${INDEX}#L1`);
  expect(screen.getByLabelText("Markdown source").textContent).toContain("title: HTTP response status codes");

  await userEvent.click(screen.getByRole("button", { name: "Rendered" }));
  expect(screen.getByRole("article", { name: "Rendered document" })).toBeTruthy();
  expect(requested.length).toBe(fetches);
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

it("shows the old path of a renamed doc", async () => {
  const files = JSON.parse(fixture("files.json")) as { filename: string; status: string; previous_filename?: string }[];
  const index = files.find((f) => f.filename === INDEX)!;
  Object.assign(index, { status: "renamed", previous_filename: "files/en-us/web/http/status/index.md" });
  responses[`${API}/pulls/45377/files?per_page=100`] = JSON.stringify(files);
  renderPage();
  const renamed = await screen.findByRole("link", {
    name: /status\/index\.md, renamed, from files\/en-us\/web\/http\/status\/index\.md/,
  });
  expect(within(renamed).getByText("R")).toBeTruthy();
  expect(within(renamed).getByText("from files/en-us/web/http/status/index.md")).toBeTruthy();
});

// Review comments. In the recording both index.md threads are outdated, so tests that need a
// current anchor move the suggestion thread onto head line 30 (as if it was written on the head).
const SUGGESTION = 3945848286; // hamishwillee's suggestion on index.md
const LINTER = 3945851001; // reviewdog's outdated suggestion on index.md

type RawComment = Record<string, unknown> & { id: number };
function editComments(edit: (comments: RawComment[]) => void) {
  const comments = JSON.parse(fixture("review-comments.json")) as RawComment[];
  edit(comments);
  responses[`${API}/pulls/45377/comments?per_page=100`] = JSON.stringify(comments);
}
const suggestionOnHead = () =>
  editComments((cs) =>
    Object.assign(
      cs.find((c) => c.id === SUGGESTION)!,
      { line: 30, commit_id: HEAD },
    ),
  );

const rail = () => screen.getByRole("complementary", { name: /Comments/ });
const threadCard = async (name: RegExp) =>
  within(await screen.findByRole("complementary", { name: /Comments/ })).findByRole("region", { name });
const anchorOf = (card: HTMLElement) => document.querySelector<HTMLElement>(`[aria-details~="${card.id}"]`);

it("shows the selected doc's threads in the rail beside their anchors, and switches with the doc", async () => {
  suggestionOnHead();
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const card = await threadCard(/GitHub line comment · L30, by hamishwillee/);
  const article = screen.getByRole("article", { name: "Rendered document" });
  expect(article.contains(anchorOf(card))).toBe(true);
  // The outdated linter thread has no anchor on head; it is listed apart.
  const unanchored = within(rail()).getByRole("region", { name: "Not placed in document" });
  expect(within(unanchored).getByRole("region", { name: /by github-actions\[bot\], outdated/ })).toBeTruthy();

  await userEvent.click(fileLink(/102\/index\.md/));
  expect(await within(rail()).findByText("No review comments on this document.")).toBeTruthy();
  expect(within(rail()).queryByRole("region", { name: /by hamishwillee/ })).toBeNull();
});

it("highlights the active thread's anchor; clicking an anchor opens its thread in the slide-over", async () => {
  localStorage.setItem("rr-rail", "collapsed");
  suggestionOnHead();
  const router = renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const card = await threadCard(/GitHub line comment · L30/);
  const anchor = anchorOf(card)!;
  expect(anchor.hasAttribute("data-rr-active")).toBe(false);

  await userEvent.click(anchor);
  expect(document.documentElement.dataset.rail).toBe("slide");
  await vi.waitFor(() => expect(document.activeElement).toBe(card));
  expect(card.className).toContain("rr-thread-active");
  expect(anchor.hasAttribute("data-rr-active")).toBe(true);
  expect(router.state.location.search).toMatchObject({ thread: SUGGESTION });
});

it("anchors are keyboard operable", async () => {
  suggestionOnHead();
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const card = await threadCard(/GitHub line comment · L30/);
  const anchor = anchorOf(card)!;
  anchor.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(document.activeElement).toBe(card));
});

it("puts each margin marker right after its anchor in tab order", async () => {
  localStorage.setItem("rr-rail", "collapsed");
  suggestionOnHead();
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const anchor = anchorOf(await threadCard(/GitHub line comment · L30/))!;
  const marker = await screen.findByRole("button", { name: /1 comment, current\. Open in comment rail/ });
  const article = screen.getByRole("article", { name: "Rendered document" });

  anchor.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(marker);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(anchor);
  // Past the marker, Tab carries on in the document after the anchor.
  await userEvent.tab();
  await userEvent.tab();
  expect(article.contains(document.activeElement)).toBe(true);
  expect(anchor.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(marker);
});

it("selects the thread from the thread param on load, and updates the param when another is activated", async () => {
  suggestionOnHead();
  const router = renderPage(`?doc=${encodeURIComponent(INDEX)}&thread=${SUGGESTION}`);
  const card = await threadCard(/GitHub line comment · L30/);
  await vi.waitFor(() => expect(document.activeElement).toBe(card));
  expect(anchorOf(card)!.hasAttribute("data-rr-active")).toBe(true);

  await userEvent.click(await threadCard(/by github-actions\[bot\], outdated/));
  expect(router.state.location.search).toMatchObject({ doc: INDEX, thread: LINTER });
  expect(anchorOf(card)!.hasAttribute("data-rr-active")).toBe(false);
});

it("filters threads by state with counts; resolution is unknown anonymously", async () => {
  suggestionOnHead();
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await threadCard(/GitHub line comment · L30/);
  const filters = within(rail()).getByRole("group", { name: "Filter comments" });
  expect(within(filters).getByRole("button", { name: "Current 1" })).toBeTruthy();
  expect(within(filters).getByRole("button", { name: "Resolved 0" })).toBeTruthy();
  expect(within(filters).getByRole("button", { name: "Outdated 1" })).toBeTruthy();
  // Unknown resolution claims neither state.
  expect(within(rail()).queryByText("Unresolved")).toBeNull();

  await userEvent.click(within(filters).getByRole("button", { name: "Outdated 1" }));
  expect(within(rail()).queryByRole("region", { name: /outdated/ })).toBeNull();
  expect(within(rail()).getByRole("region", { name: /GitHub line comment · L30/ })).toBeTruthy();
});

it("never asks GraphQL for thread resolution anonymously", async () => {
  // Anonymous GraphQL answers 403 with a zero rate limit, which would push every later call
  // through the proxy until the reported reset.
  suggestionOnHead();
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await threadCard(/GitHub line comment · L30/);
  expect(requested.filter((u) => u.includes("graphql"))).toEqual([]);
});

it("counts threads per doc in the sidebar and the doc's threads on the Comments button", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  // Resolution is unknown anonymously, so the count does not claim the threads are unresolved.
  const link = await screen.findByRole("link", { name: /status\/index\.md, modified, 2 comments$/ });
  expect(link.getAttribute("aria-label")).not.toContain("unresolved");
  expect(screen.getByRole("button", { name: /Comments 2/ })).toBeTruthy();
});

it("shows review summaries and the PR conversation, without the Rendered Review link comment", async () => {
  const comments = JSON.parse(fixture("issue-comments.json")) as Record<string, unknown>[];
  comments.push({
    ...comments[0],
    id: 1,
    body: "<!-- rendered-review-link:v1 -->\nReview the rendered documents",
    html_url: "https://github.com/mdn/content/pull/45377#issuecomment-1",
  });
  responses[`${API}/issues/45377/comments?per_page=100`] = JSON.stringify(comments);
  renderPage();
  await screen.findByRole("article", { name: "Rendered document" });
  const reviews = await within(rail()).findByRole("region", { name: /Reviews/ });
  expect(within(reviews).getByRole("article", { name: "Approved by hamishwillee" })).toBeTruthy();
  expect(within(reviews).getByText("Looks great - thanks.")).toBeTruthy();
  const conversation = within(rail()).getByRole("region", { name: /Conversation/ });
  expect(within(conversation).getAllByRole("article")).toHaveLength(1);
  expect(within(conversation).getByText("Preview URLs")).toBeTruthy();
  expect(within(rail()).queryByText("Review the rendered documents")).toBeNull();
});

it("places a deleted doc's LEFT-side threads on its base revision", async () => {
  editComments((cs) =>
    cs.push({
      ...cs.find((c) => c.id === SUGGESTION)!,
      id: 1,
      node_id: "PRRC_left",
      path: DELETED,
      side: "LEFT",
      line: 11,
      original_line: 11,
      body: "Keep a note of why this was removed.",
    }),
  );
  renderPage();
  const card = await threadCard(/GitHub line comment · L11 \(base\)/);
  const anchor = anchorOf(card)!;
  expect(screen.getByRole("article", { name: "Rendered document" }).contains(anchor)).toBe(true);
  expect(anchor.textContent).toContain("102 Processing");
});

it("lists a comment on a blank line as not placed, saying why", async () => {
  editComments((cs) =>
    Object.assign(
      cs.find((c) => c.id === SUGGESTION)!,
      { line: 8, commit_id: HEAD },
    ),
  );
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const card = await threadCard(/GitHub line comment · L8, by hamishwillee/);
  expect(anchorOf(card)).toBeNull();
  expect(within(rail()).getByRole("region", { name: "Not placed in document" }).contains(card)).toBe(true);
  expect(within(card).getByText(/no rendered block at this line/)).toBeTruthy();
});
