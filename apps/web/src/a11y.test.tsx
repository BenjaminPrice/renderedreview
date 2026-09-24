// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Automated accessibility checks (axe) over the app's main surfaces, rendered from the
// mdn/content#45377 recording: no serious or critical violations anywhere.
import { readFileSync } from "node:fs";
import { createDiagramRegistry, type DiagramRenderer } from "@rendered-review/diagram-domain";
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderedDocument } from "./document/document";
import { DiagramRegistryContext } from "./diagram/registry";
import { browserCache } from "./github/client";
import { routeTree } from "./routeTree.gen";
import { allowedHostsQuery } from "./routes/$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "./routes/__root";
import { expectNoSeriousA11yViolations, renderWithRouter } from "./test-utils";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/document/fixtures/${name}`, "utf8");
const HEAD = "db23e1ea65fa47a95d8414d2d8be806a26dccf49";
const BASE = "358daf81ac9cf3db999cc8af7aed81ef4ff0c3f6";
const INDEX = "files/en-us/web/http/reference/status/index.md";
const LINTED = "cd176a8b0178a6911d7b36fb83c8ce6d7c10f44f";
const API = "https://api.github.com/repos/mdn/content";
const SUGGESTION = 3945848286;

let responses: Record<string, string>;

beforeEach(() => {
  // The suggestion thread moved onto head line 30, so one thread is current and one outdated.
  const comments = JSON.parse(fixture("review-comments.json")) as Record<string, unknown>[];
  Object.assign(
    comments.find((c) => c.id === SUGGESTION)!,
    { line: 30, commit_id: HEAD },
  );
  responses = {
    "/api/auth/viewer": '{"login":"octocat","avatarUrl":null}',
    [`${API}/pulls/45377`]: fixture("pull.json"),
    [`${API}/pulls/45377/files?per_page=100`]: fixture("files.json"),
    [`${API}/pulls/45377/comments?per_page=100`]: JSON.stringify(comments),
    [`${API}/pulls/45377/reviews?per_page=100`]: fixture("reviews.json"),
    [`${API}/issues/45377/comments?per_page=100`]: fixture("issue-comments.json"),
    [`${API}/pulls/45377/review-threads`]: JSON.stringify([
      { nodeId: "PRRT_suggestion", isResolved: false, commentIds: [SUGGESTION] },
    ]),
    [`${API}/pulls/45377/commits?per_page=100`]: fixture("pull-commits.json"),
    [`${API}/contents/${INDEX}?ref=${BASE}`]: fixture("blob-4e1326aa2512d4d8eec8533471eee0dc684de810.md"),
    [`${API}/contents/${INDEX}?ref=${LINTED}`]: fixture("blob-e5e23959a5d5d851063e4a5f68f166baa7bbd358.md"),
  };
  for (const oid of [
    "1a05f7e9c35e2bb310563708351758307f34a599",
    "d8730ec82103b7ac29d4cdc0bdd9dfd575c49441",
    "e5e23959a5d5d851063e4a5f68f166baa7bbd358",
  ])
    responses[`${API}/git/blobs/${oid}`] = fixture(`blob-${oid}.md`);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = responses[url.replace("/api/github/user/github.com/", "https://api.github.com/")];
    return body === undefined
      ? new Response('{"message":"Not Found"}', { status: 404 })
      : new Response(body, { headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.rail;
  document.getSelection()?.removeAllRanges();
  await browserCache.clearLocalData();
});

function renderAt(url: string) {
  RootRoute.update({ component: Outlet });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(allowedHostsQuery.queryKey, { hosts: ["github.com"], proxyFirst: [] });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const PR = "/github.com/mdn/content/pull/45377";
const openDoc = (search = "") => renderAt(`${PR}?doc=${encodeURIComponent(INDEX)}${search}`);
const rail = () => screen.findByRole("complementary", { name: /Comments/ });
const threadCard = async () => within(await rail()).findByRole("region", { name: /GitHub line comment · L30/ });

/** Select `word` in the first text node containing it and open the composer from the selection popover. */
async function compose(word: string) {
  const article = await screen.findByRole("article", { name: "Rendered document" });
  await vi.waitFor(() => expect(article.textContent).toContain(word));
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && !(walker.currentNode as Text).data.includes(word));
  const text = walker.currentNode as Text;
  const from = text.data.indexOf(word);
  document.getSelection()!.setBaseAndExtent(text, from, text, from + word.length);
  article.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const actions = await screen.findByRole("toolbar", { name: "Selection actions" });
  await userEvent.click(within(actions).getByRole("button", { name: /Comment/ }));
  return screen.findByRole("region", { name: "New comment" });
}

describe("no serious axe violations", () => {
  it("on the home page, including its invalid-link error", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: "Rendered Review" });
    await expectNoSeriousA11yViolations();
    await userEvent.type(screen.getByRole("textbox", { name: "GitHub pull request URL" }), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("That is not a GitHub pull request URL.");
    await expectNoSeriousA11yViolations();
  });

  it("on the PR Overview", async () => {
    renderAt(`${PR}?view=overview`);
    const overview = await screen.findByRole("region", { name: "Pull request overview" });
    await within(overview).findByRole("list", { name: "Conversation, oldest first" });
    await expectNoSeriousA11yViolations();
  });

  it("on a document with threads in the pinned rail", async () => {
    openDoc();
    await threadCard();
    await expectNoSeriousA11yViolations();
  });

  it("on a document with the rail collapsed to margin markers, and its slide-over", async () => {
    localStorage.setItem("rr-rail", "collapsed");
    openDoc();
    await threadCard();
    await screen.findByRole("button", { name: /1 comment, current\. Open in comment rail/ });
    await expectNoSeriousA11yViolations();
    await userEvent.click(screen.getByRole("button", { name: /1 comment, current\. Open in comment rail/ }));
    await vi.waitFor(() => expect(document.documentElement.dataset.rail).toBe("slide"));
    await expectNoSeriousA11yViolations();
  });

  it("with the composer open, in comment and suggest modes", async () => {
    openDoc();
    const composer = await compose("interim response");
    await expectNoSeriousA11yViolations();
    await userEvent.click(within(composer).getByRole("button", { name: "Suggest" }));
    await expectNoSeriousA11yViolations();
  });

  it("with a draft in the rail and the submit-review dialog open", async () => {
    openDoc();
    const composer = await compose("grouped");
    await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "Grouped how?");
    await userEvent.click(within(composer).getByRole("button", { name: "Add to review" }));
    await screen.findByRole("region", { name: "Draft comment on line 10" });
    await expectNoSeriousA11yViolations();
    await userEvent.click(screen.getByRole("button", { name: /^Review/ }));
    screen.getByRole("dialog", { name: "Submit review" });
    await expectNoSeriousA11yViolations();
  });

  it("on a historical revision", async () => {
    openDoc(`&rev=${LINTED}`);
    await screen.findByRole("status", { name: "Historical revision" });
    await within(await rail()).findByRole("region", { name: /by github-actions\[bot\]$/ });
    await expectNoSeriousA11yViolations();
  });

  it("signed out, with the guest sign-in notice", async () => {
    responses["/api/auth/viewer"] = "null";
    openDoc();
    await screen.findByRole("note", { name: "GitHub guest access" });
    await threadCard();
    await expectNoSeriousA11yViolations();
  });

  it("on the PR error and document-not-found states", async () => {
    openDoc().navigate({ to: ".", search: { doc: "missing.md" } });
    await screen.findByRole("heading", { name: "Document not found" });
    await expectNoSeriousA11yViolations();
    cleanup();
    delete responses[`${API}/pulls/45377`];
    renderAt(PR);
    await screen.findByRole("heading", { name: "Pull request unavailable" });
    await expectNoSeriousA11yViolations();
  });

  it("on a diagram, its source view and its larger-view dialog", async () => {
    const renderer: DiagramRenderer = {
      id: "fake",
      fenceNames: ["mermaid"],
      version: "1",
      render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>' }),
    };
    const registry = createDiagramRegistry([{ label: "Mermaid", fenceNames: ["mermaid"], load: async () => renderer }]);
    const rendered = renderMarkdown("# Flow\n\n```mermaid\nflowchart LR\n  title Delivery flow\n  A --> B\n```\n");
    const link = { host: "github.com", owner: "acme", repo: "widgets", sha: "0123456", path: "docs/flow.md" };
    await renderWithRouter(() => (
      <main>
        <DiagramRegistryContext value={registry}>
          <RenderedDocument rendered={rendered} changes={[]} link={link} blobOid="a11y-diagram" />
        </DiagramRegistryContext>
      </main>
    ));
    const figure = screen.getByRole("figure", { name: "Mermaid diagram: Delivery flow" });
    await within(figure).findByRole("img");
    await expectNoSeriousA11yViolations();
    await userEvent.click(within(figure).getByRole("button", { name: "Source" }));
    await expectNoSeriousA11yViolations();
    await userEvent.click(within(figure).getByRole("button", { name: "Source" }));
    await userEvent.click(within(figure).getByRole("button", { name: "Open larger view" }));
    screen.getByRole("dialog", { name: "Mermaid diagram: Delivery flow" });
    await expectNoSeriousA11yViolations();
  });
});
