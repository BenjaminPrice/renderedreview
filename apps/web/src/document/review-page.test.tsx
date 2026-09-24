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
import { expectNewTab } from "../test-utils";
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
    // The base revision of the modified document, read by path instead of through the base tree.
    [`${API}/contents/${INDEX}?ref=${BASE}`]: fixture("blob-4e1326aa2512d4d8eec8533471eee0dc684de810.md"),
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
    // Signed in, the authenticated endpoint answers what GitHub would.
    const body = responses[url.replace("/api/github/user/github.com/", "https://api.github.com/")];
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
  const openInGitHub = screen.getByRole("link", { name: "Open in GitHub (opens in new tab)" });
  expectNewTab(openInGitHub);
  expect(openInGitHub.getAttribute("href")).toBe("https://github.com/mdn/content/pull/45377");

  const deleted = fileLink(/102\/index\.md, deleted/);
  const modified = fileLink(/status\/index\.md, modified/);
  expect(within(deleted).getByText("D")).toBeTruthy();
  expect(within(deleted).getByText("historical · base revision")).toBeTruthy();
  expect(within(modified).getByText("M")).toBeTruthy();
  // The non-Markdown change links out instead of opening here.
  expect(within(sidebar()).getByText(/1 other file changed/)).toBeTruthy();
  expectNewTab(within(sidebar()).getByRole("link", { name: "view on GitHub (opens in new tab)" }));
});

it("opens the first changed doc; a deleted doc renders read-only from the base revision", async () => {
  renderPage();
  const article = await screen.findByRole("article", { name: "Rendered document" });
  // The deleted page's title comes from its front matter.
  expect(within(article).getAllByRole("definition")[0]!.textContent).toBe("102 Processing");
  expect(fileLink(/102\/index\.md/).getAttribute("aria-current")).toBe("page");
  expect(screen.getByText(/Deleted in this pull request\. Showing the base revision/)).toBeTruthy();
  const source = screen.getByRole("link", { name: "Source (opens in new tab)" });
  expectNewTab(source);
  expect(source.getAttribute("href")).toBe(`https://github.com/mdn/content/blob/${BASE}/${DELETED}`);
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

it("opens changed docs without fetching a recursive tree", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const article = await screen.findByRole("article", { name: "Rendered document" });
  await vi.waitFor(() => expect(article.querySelector('[data-rr-change="modified"]')).toBeTruthy());
  await userEvent.click(fileLink(/102\/index\.md/));
  await screen.findByText(/Deleted in this pull request/);
  expect(requested.filter((u) => u.includes("/git/trees/"))).toEqual([]);
});

it("fetches the head tree once for All docs, not per document open", async () => {
  const head = withHead("c".repeat(40), fixture("tree-head.json"));
  renderPage("?files=all");
  await userEvent.click(await screen.findByRole("link", { name: /status\/index\.md, modified/ }));
  await screen.findByRole("article", { name: "Rendered document" });
  await userEvent.click(fileLink(/README\.md, unchanged/));
  await userEvent.click(fileLink(/status\/index\.md, modified/));
  await screen.findByRole("article", { name: "Rendered document" });
  expect(requested.filter((u) => u.includes("/git/trees/"))).toEqual([`${API}/git/trees/${head}?recursive=1`]);
});

it("shows a document's front matter as terms and definitions, not as a heading", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const article = await screen.findByRole("article", { name: "Rendered document" });
  const terms = await within(article).findAllByRole("term");
  expect(terms.map((t) => t.textContent)).toEqual(["title", "slug", "page-type", "browser-compat", "sidebar"]);
  expect(within(article).getAllByRole("definition")[0]!.textContent).toBe("HTTP response status codes");
  expect(within(article).queryByRole("heading", { name: /title:/ })).toBeNull();
});

it("shows GitHub alerts as titled callouts without the marker", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  const article = await screen.findByRole("article", { name: "Rendered document" });
  const title = await within(article).findByText("Note");
  expect(title.closest(".markdown-alert-note")?.textContent).toMatch(/^Note\s*If you receive a response/);
  expect(within(article).queryByText(/\[!NOTE\]/)).toBeNull();
});

it("scrolls the document back to the top when another doc is opened", async () => {
  renderPage();
  await screen.findByRole("article", { name: "Rendered document" });
  const scroller = document.querySelector<HTMLElement>(".rr-scroll")!;
  scroller.scrollTop = 500;
  expect(scroller.scrollTop).toBe(500);

  await userEvent.click(fileLink(/status\/index\.md, modified/));
  await screen.findByText("HTTP response status codes", { selector: "dd" });
  expect(scroller.scrollTop).toBe(0);
});

it("switches to raw source with GitHub line links, and back, without refetching", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await screen.findByRole("article", { name: "Rendered document" });
  const fetches = requested.length;

  await userEvent.click(screen.getByRole("button", { name: "Raw" }));
  const line1 = screen.getByRole("link", { name: "Line 1 on GitHub (opens in new tab)" });
  expectNewTab(line1);
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

/** Serves the PR at a fresh head commit with `tree`: trees are cached by OID for the whole test file. */
function withHead(sha: string, tree: string) {
  const pr = JSON.parse(fixture("pull.json")) as { head: { sha: string } };
  pr.head.sha = sha;
  responses[`${API}/pulls/45377`] = JSON.stringify(pr);
  responses[`${API}/git/trees/${sha}?recursive=1`] = tree;
  return sha;
}

// A synthetic head tree the size of a very large documentation repository.
const BIG = 15_000;
const bigPath = (i: number) => `docs/${String(i).padStart(5, "0")}.md`;
const withBigTree = () =>
  withHead(
    "e".repeat(40),
    JSON.stringify({
      sha: "e".repeat(40),
      truncated: false,
      tree: Array.from({ length: BIG }, (_, i) => ({
        path: bigPath(i),
        mode: "100644",
        type: "blob",
        sha: i.toString(16).padStart(40, "0"),
      })),
    }),
  );
const allList = () => screen.findByRole("list", { name: "All documents" });
const rows = (list: HTMLElement) => within(list).getAllByRole("listitem");
const activeRow = () => document.activeElement!.closest("li")!;

it("renders only a window of a 15,000-document All docs list, with the list size exposed", async () => {
  withBigTree();
  renderPage("?files=all");
  const list = await allList();
  await vi.waitFor(() => expect(rows(list).length).toBeGreaterThan(0));
  expect(rows(list).length).toBeLessThan(100);
  expect(rows(list)[0]!.getAttribute("aria-setsize")).toBe(String(BIG));
  expect(rows(list)[0]!.getAttribute("aria-posinset")).toBe("1");
  expect(within(sidebar()).getByRole("button", { name: /All docs/ }).textContent).toContain(String(BIG));
});

it("moves through the whole virtualized list with the keyboard", async () => {
  withBigTree();
  renderPage("?files=all");
  const list = await allList();
  within(list).getAllByRole("link")[0]!.focus();
  await userEvent.keyboard("{End}");
  expect(activeRow().getAttribute("aria-posinset")).toBe(String(BIG));
  expect(document.activeElement!.getAttribute("title")).toBe(bigPath(BIG - 1));
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement!.getAttribute("title")).toBe(bigPath(BIG - 2));
  await userEvent.keyboard("{Home}");
  expect(activeRow().getAttribute("aria-posinset")).toBe("1");
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement!.getAttribute("title")).toBe(bigPath(1));
  expect(rows(list).length).toBeLessThan(100);
});

it("keeps a deep-linked document far down the All docs list reachable", async () => {
  withBigTree();
  renderPage(`?files=all&doc=${encodeURIComponent(bigPath(9_000))}`);
  const list = await allList();
  const link = await within(list).findByRole("link", { current: "page" });
  expect(link.getAttribute("title")).toBe(bigPath(9_000));
  expect(link.getAttribute("tabindex")).toBe("0");
});

it("filters All docs by path, case-insensitively, and announces the count", async () => {
  withBigTree();
  renderPage("?files=all");
  const list = await allList();
  await userEvent.type(within(sidebar()).getByRole("searchbox", { name: "Filter documents" }), "DOCS/0999");
  // 00999 and 09990 to 09999.
  await vi.waitFor(() => expect(rows(list)).toHaveLength(11));
  expect(within(sidebar()).getByRole("status").textContent).toBe("11 documents");
  expect(rows(list)[0]!.getAttribute("aria-setsize")).toBe("11");
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
  expect(screen.getByRole("link", { name: "Line 1 on GitHub (opens in new tab)" })).toBeTruthy();
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

it("signed in, reads through the authenticated endpoint and shows real thread resolution", async () => {
  suggestionOnHead();
  responses["/api/auth/viewer"] = '{"login":"octocat","avatarUrl":null}';
  const thread = (nodeId: string, id: number, isResolved: boolean) => ({ nodeId, isResolved, commentIds: [id] });
  responses[`${API}/pulls/45377/review-threads`] = JSON.stringify([
    thread("PRRT_suggestion", SUGGESTION, false),
    thread("PRRT_linter", LINTER, true),
  ]);
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await threadCard(/GitHub line comment · L30/);
  const filters = within(rail()).getByRole("group", { name: "Filter comments" });
  expect(within(filters).getByRole("button", { name: "Resolved 1" })).toBeTruthy();
  expect(within(rail()).getAllByText("Unresolved").length).toBeGreaterThan(0);
  const github = requested.filter((u) => u !== "/api/auth/viewer");
  expect(github.length).toBeGreaterThan(0);
  expect(github.every((u) => u.startsWith("/api/github/user/github.com/"))).toBe(true);
});

it("counts threads per doc in the sidebar and the doc's threads on the Comments button", async () => {
  renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  // Resolution is unknown anonymously, so the count does not claim the threads are unresolved.
  const link = await screen.findByRole("link", { name: /status\/index\.md, modified, 2 comments$/ });
  expect(link.getAttribute("aria-label")).not.toContain("unresolved");
  expect(screen.getByRole("button", { name: /Comments 2/ })).toBeTruthy();
});

it("shows only the document's threads in its rail, with a pointer to the PR conversation in Overview", async () => {
  const router = renderPage(`?doc=${encodeURIComponent(INDEX)}`);
  await screen.findByRole("article", { name: "Rendered document" });
  const note = await within(rail()).findByText(/PR conversation \(2\) is in/);
  expect(within(rail()).queryByRole("region", { name: /Reviews|Conversation/ })).toBeNull();
  expect(within(rail()).queryByText("Preview URLs")).toBeNull();
  await userEvent.click(within(note).getByRole("link", { name: "Overview" }));
  expect(router.state.location.search).toMatchObject({ view: "overview" });
  expect(router.state.location.search).not.toHaveProperty("doc");
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

// PR Overview: the pull request's description and conversation, opened from the sidebar.
const overview = () => screen.findByRole("region", { name: "Pull request overview" });
const prEntry = () => within(sidebar()).getByRole("link", { name: /^Pull request #45377/ });
const LINK_COMMENT = 5454381559; // the mdn preview-URL bot's conversation comment

type RawItem = Record<string, unknown> & { id: number };
function edit(name: string, url: string, change: (items: RawItem[]) => void) {
  const items = JSON.parse(fixture(name)) as RawItem[];
  change(items);
  responses[url] = JSON.stringify(items);
}
const editIssueComments = (change: (items: RawItem[]) => void) =>
  edit("issue-comments.json", `${API}/issues/45377/comments?per_page=100`, change);
const editReviews = (change: (items: RawItem[]) => void) =>
  edit("reviews.json", `${API}/pulls/45377/reviews?per_page=100`, change);
function editPull(change: (pr: Record<string, unknown>) => void) {
  const pr = JSON.parse(fixture("pull.json")) as Record<string, unknown>;
  change(pr);
  responses[`${API}/pulls/45377`] = JSON.stringify(pr);
}

it("shows a Pull request block above the documents that opens the Overview", async () => {
  const router = renderPage();
  await screen.findByRole("article", { name: "Rendered document" });
  const entry = await vi.waitFor(() => {
    const link = prEntry();
    expect(link.textContent).toContain("Overview · 2 comments");
    return link;
  });
  expect(within(entry).getByText("1 approval")).toBeTruthy();
  expect(within(entry).getByRole("img", { name: "Reviewers: hamishwillee, github-actions[bot]" })).toBeTruthy();
  expect(entry.getAttribute("aria-current")).toBeNull();
  expect(within(sidebar()).getByText("Documents")).toBeTruthy();

  await userEvent.click(entry);
  expect(router.state.location.search).toMatchObject({ view: "overview" });
  await overview();
  expect(prEntry().getAttribute("aria-current")).toBe("page");
  expect(within(sidebar()).queryAllByRole("link", { current: "page" })).toHaveLength(1);
});

it("opens the Overview from the keyboard", async () => {
  const router = renderPage();
  await screen.findByRole("article", { name: "Rendered document" });
  prEntry().focus();
  await userEvent.keyboard("{Enter}");
  expect(router.state.location.search).toMatchObject({ view: "overview" });
});

it("shows the PR header band and its description as sanitized Markdown", async () => {
  editPull((pr) => {
    pr.body += "\n\n<script>alert(1)</script><img src=x onerror=alert(1) alt=x>";
  });
  renderPage("?view=overview");
  const region = await overview();
  const band = within(region).getByRole("heading", {
    level: 2,
    name: "Remove HTTP status 102 page #45377",
  }).parentElement!;
  expect(within(band).getByText("Pull request")).toBeTruthy();
  expect(within(band).getByText("Merged")).toBeTruthy();
  expect(band.textContent).toContain("OnkarRuikar merged 4 commits into");
  expect(within(band).getByText("main")).toBeTruthy();
  expect(within(band).getByText("OnkarRuikar:delete_102_http_status_page")).toBeTruthy();
  expect(within(band).getByText("Content:HTTP")).toBeTruthy();
  expect(within(band).getByText("size/s")).toBeTruthy();

  const description = within(region).getByRole("region", { name: "Description" });
  expect(within(description).getByRole("heading", { name: "More Info" })).toBeTruthy();
  expect(description.textContent).toContain("npm run content delete Web/HTTP/Reference/Status/102");
  const external = within(description).getByRole("link", { name: /not being tracked in BCD/ });
  expect(external.getAttribute("target")).toBe("_blank");
  expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  expectNewTab(within(description).getByRole("link", { name: "Edit on GitHub (opens in new tab)" }));
  expect(description.querySelector("script")).toBeNull();
  expect(description.querySelector("[onerror]")).toBeNull();
});

it("says when the PR has no description", async () => {
  editPull((pr) => {
    pr.body = null;
  });
  renderPage("?view=overview");
  const description = within(await overview()).getByRole("region", { name: "Description" });
  expect(within(description).getByText("No description provided.")).toBeTruthy();
});

it("lists the conversation and review events oldest first, without the Rendered Review link comment", async () => {
  editIssueComments((cs) =>
    cs.push({
      ...cs[0]!,
      id: 1,
      body: "<!-- rendered-review-link:v1 -->\nReview the rendered documents",
      created_at: "2026-09-01T00:00:00Z",
    }),
  );
  editReviews((rs) =>
    rs.push({
      ...rs[0]!,
      id: 2,
      state: "CHANGES_REQUESTED",
      body: "Please keep a note.",
      submitted_at: "2026-08-30T00:00:00Z",
    }),
  );
  renderPage("?view=overview");
  const list = await within(await overview()).findByRole("list", { name: "Conversation, oldest first" });
  const items = [...list.children] as HTMLElement[];
  expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
    "github-actions[bot] commented",
    "hamishwillee requested changes",
    "hamishwillee approved these changes",
  ]);
  expect(within(items[0]!).getByText("Preview URLs")).toBeTruthy();
  expect(within(items[1]!).getByText("Changes requested")).toBeTruthy();
  expect(within(items[1]!).getByText("Please keep a note.")).toBeTruthy();
  expect(within(items[2]!).getByText("Approved")).toBeTruthy();
  expect(within(items[2]!).getByText("Looks great - thanks.")).toBeTruthy();
  expect(screen.queryByText("Review the rendered documents")).toBeNull();
});

it("jumps from a permalink comment to its document and focuses the lines", async () => {
  editIssueComments((cs) =>
    cs.push({ ...cs[0]!, id: 2, body: `Why this line? https://github.com/mdn/content/blob/${HEAD}/${INDEX}#L30` }),
  );
  const router = renderPage("?view=overview");
  const jump = await within(await overview()).findByRole("link", { name: `Jump to ${INDEX} · L30` });
  await userEvent.click(jump);
  expect(router.state.location.search).toMatchObject({ doc: INDEX });
  expect(router.state.location.search).not.toHaveProperty("view");
  const article = await screen.findByRole("article", { name: "Rendered document" });
  await vi.waitFor(() => expect(article.contains(document.activeElement)).toBe(true));
  expect(document.activeElement!.textContent).toContain("WebDAV");
});

it("jumps from a review to its thread in the document", async () => {
  suggestionOnHead();
  editReviews((rs) =>
    Object.assign(
      rs.find((r) => r.id === 5127229684)!,
      { body: "One suggestion." },
    ),
  );
  const router = renderPage("?view=overview");
  const item = await within(await overview()).findByRole("listitem", { name: "hamishwillee reviewed" });
  await userEvent.click(within(item).getByRole("link", { name: `Jump to ${INDEX} · L30` }));
  expect(router.state.location.search).toMatchObject({ doc: INDEX, thread: SUGGESTION });
  const card = await threadCard(/GitHub line comment · L30/);
  await vi.waitFor(() => expect(document.activeElement).toBe(card));
});

it("opens the Overview at a conversation comment linked by the thread param", async () => {
  renderPage(`?thread=${LINK_COMMENT}`);
  const item = await within(await overview()).findByRole("listitem", { name: "github-actions[bot] commented" });
  await vi.waitFor(() => expect(item.contains(document.activeElement)).toBe(true));
});

it("lists documents with comments in the Overview rail, without filters, connectors or markers", async () => {
  localStorage.setItem("rr-connectors", "on");
  const router = renderPage("?view=overview");
  await overview();
  const docs = await screen.findByRole("complementary", { name: "Documents with comments 1" });
  const row = await within(docs).findByRole("link", { name: /status\/index\.md/ });
  expect(row.textContent).toContain("2 outdated");
  expect(within(row).getByText("M")).toBeTruthy();
  expect(within(docs).queryByText(/_redirects/)).toBeNull(); // not a document
  expect(within(docs).queryByRole("group", { name: "Filter comments" })).toBeNull();
  expect(within(docs).queryByRole("switch", { name: "Show connectors" })).toBeNull();
  expect(document.querySelector(".rr-marker, .rr-wires")).toBeNull();

  row.focus();
  await userEvent.keyboard("{Enter}");
  expect(router.state.location.search).toMatchObject({ doc: INDEX });
  expect(await screen.findByRole("article", { name: "Rendered document" })).toBeTruthy();
});

it("shows no count on the Comments button in Overview, and the document's count in a document", async () => {
  const router = renderPage("?view=overview");
  await overview();
  expect(screen.getByRole("button", { name: "Comments" }).getAttribute("aria-controls")).toBe("rr-rail");
  await router.navigate({ to: ".", search: { files: "changed", doc: INDEX } });
  expect(await screen.findByRole("button", { name: "Comments 2" })).toBeTruthy();
});

it("shows a PR breadcrumb in Overview and a file breadcrumb in a document", async () => {
  const router = renderPage("?view=overview");
  await overview();
  const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(crumbs.textContent).toMatch(/mdn\/content.*Pull request #45377.*Overview/);
  expect(within(crumbs).getByText("Overview").getAttribute("aria-current")).toBe("page");
  const toolbar = crumbs.closest(".rr-toolbar") as HTMLElement;
  expectNewTab(within(toolbar).getByRole("link", { name: "Open in GitHub (opens in new tab)" }));
  expect(within(toolbar).queryByRole("button", { name: "Raw" })).toBeNull();
  expect(within(toolbar).queryByRole("link", { name: /Source/ })).toBeNull();

  await router.navigate({ to: ".", search: { files: "changed", doc: INDEX } });
  await screen.findByRole("article", { name: "Rendered document" });
  const fileCrumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(fileCrumbs.textContent).toContain(`mdn/content›#45377›${INDEX}`);
  expect(within(fileCrumbs).getByText(INDEX.split("/").pop()!).closest("[aria-current=page]")).toBeTruthy();
  await userEvent.click(within(fileCrumbs).getByRole("link", { name: "#45377" }));
  expect(router.state.location.search).toMatchObject({ view: "overview" });
});

it("lands on the Overview when no Markdown changed", async () => {
  edit("files.json", `${API}/pulls/45377/files?per_page=100`, (fs) =>
    fs.splice(0, fs.length, ...fs.filter((f) => !String(f.filename).endsWith(".md"))),
  );
  renderPage();
  expect(await overview()).toBeTruthy();
  expect(prEntry().getAttribute("aria-current")).toBe("page");
});
