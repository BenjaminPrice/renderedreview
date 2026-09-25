// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Reviewing without a mouse, end to end: open a document from the sidebar, open a thread from its
// anchor, select text with Shift+arrows, comment, submit the review, reply to and resolve a thread,
// and switch revision. GitHub reads come from the mdn/content#45377 recording; writes are answered here.
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { browserCache } from "./github/client";
import { routeTree } from "./routeTree.gen";
import { allowedHostsQuery } from "./routes/$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "./routes/__root";
import { stubSelectionModify } from "./test-utils";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/document/fixtures/${name}`, "utf8");
const HEAD = "db23e1ea65fa47a95d8414d2d8be806a26dccf49";
const BASE = "358daf81ac9cf3db999cc8af7aed81ef4ff0c3f6";
const INDEX = "files/en-us/web/http/reference/status/index.md";
const LINTED = "cd176a8b0178a6911d7b36fb83c8ce6d7c10f44f";
const API = "https://api.github.com/repos/mdn/content";
const WRITE = "/api/github/write/github.com/mdn/content/pulls/45377";
const SUGGESTION = 3945848286;

beforeAll(stubSelectionModify);

let responses: Record<string, string>;
let posted: { url: string; body: Record<string, unknown> }[];

function threads(isResolved: boolean) {
  responses[`${API}/pulls/45377/review-threads`] = JSON.stringify([
    { nodeId: "PRRT_suggestion", isResolved, commentIds: [SUGGESTION] },
  ]);
}

beforeEach(() => {
  posted = [];
  // The suggestion thread moved onto head line 30, so it is current and anchored.
  const comments = JSON.parse(fixture("review-comments.json")) as Record<string, unknown>[];
  Object.assign(
    comments.find((c) => c.id === SUGGESTION)!,
    { line: 30, commit_id: HEAD },
  );
  responses = {
    "/api/auth/viewer": '{"login":"octocat","avatarUrl":null}',
    // Write access, so GitHub lets the viewer resolve threads.
    [API]: JSON.stringify({ permissions: { admin: false, push: true, pull: true } }),
    [`${API}/pulls/45377`]: fixture("pull.json"),
    [`${API}/pulls/45377/files?per_page=100`]: fixture("files.json"),
    [`${API}/pulls/45377/comments?per_page=100`]: JSON.stringify(comments),
    [`${API}/pulls/45377/reviews?per_page=100`]: fixture("reviews.json"),
    [`${API}/issues/45377/comments?per_page=100`]: fixture("issue-comments.json"),
    [`${API}/pulls/45377/commits?per_page=100`]: fixture("pull-commits.json"),
    [`${API}/contents/${INDEX}?ref=${BASE}`]: fixture("blob-4e1326aa2512d4d8eec8533471eee0dc684de810.md"),
    [`${API}/contents/${INDEX}?ref=${LINTED}`]: fixture("blob-e5e23959a5d5d851063e4a5f68f166baa7bbd358.md"),
    [`${WRITE}/reply`]: JSON.stringify({ comment: { id: 1 } }),
    [`${WRITE}/resolve`]: JSON.stringify({ thread: { nodeId: "PRRT_suggestion", isResolved: true } }),
  };
  threads(false);
  for (const oid of ["1a05f7e9c35e2bb310563708351758307f34a599", "d8730ec82103b7ac29d4cdc0bdd9dfd575c49441"])
    responses[`${API}/git/blobs/${oid}`] = fixture(`blob-${oid}.md`);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ url, body });
      // Every draft in a submitted review publishes.
      if (url === `${WRITE}/review`)
        return Response.json({
          ok: true,
          results: (body.drafts as { id: string }[]).map((d) => ({ draftId: d.id, ok: true })),
        });
    }
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
  document.getSelection()?.removeAllRanges();
  await browserCache.clearLocalData();
});

function renderPage() {
  RootRoute.update({ component: Outlet });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(allowedHostsQuery.queryKey, { hosts: ["github.com"], proxyFirst: [] });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/github.com/mdn/content/pull/45377"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Presses Tab (or Shift+Tab) until `target` has focus; fails if it is not in the tab order. */
async function tabTo(target: () => Element | null, { back = false } = {}) {
  for (let i = 0; i < 300; i++) {
    const el = target();
    if (el && document.activeElement === el) return el as HTMLElement;
    await userEvent.tab({ shift: back });
  }
  throw new Error(`Not reachable with ${back ? "Shift+Tab" : "Tab"}: ${target()?.outerHTML.slice(0, 120)}`);
}

it("reviews a document end to end with the keyboard alone", async () => {
  const router = renderPage();
  const sidebar = await screen.findByRole("navigation", { name: "Documents" });

  // Open the document from the sidebar: Tab into the list, arrow down to it.
  const docs = await within(sidebar).findByRole("list", { name: "Changed documents" });
  await tabTo(() => docs.querySelector('a[tabindex="0"]'));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(within(docs).getByRole("link", { name: /status\/index\.md, modified/ }));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ doc: INDEX }));
  const article = await screen.findByRole("article", { name: "Rendered document" });

  // Tab to the anchored block and open its thread.
  const rail = await screen.findByRole("complementary", { name: /Comments/ });
  const card = await within(rail).findByRole("region", { name: /GitHub line comment · L30, by hamishwillee/ });
  const anchor = () => article.querySelector(`[aria-details~="${card.id}"]`);
  await tabTo(anchor);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(document.activeElement).toBe(card));

  // Back in the document, select a word with Shift+arrows and comment on it with C.
  await tabTo(anchor, { back: true });
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}");
  const selected = document.getSelection()!.toString();
  expect(selected).toHaveLength(3);
  expect(anchor()!.textContent).toContain(selected);
  await screen.findByRole("toolbar", { name: "Selection actions" });
  await userEvent.keyboard("c");
  const composer = await screen.findByRole("region", { name: "New comment" });
  expect(document.activeElement).toBe(within(composer).getByRole("textbox", { name: "Comment" }));
  await userEvent.keyboard("Which one?");
  await tabTo(() => within(composer).getByRole("button", { name: "Add to review" }));
  await userEvent.keyboard("{Enter}");
  const draft = await screen.findByRole("region", { name: /^Draft comment on line/ });

  // Submit the review from the top bar.
  const review = await screen.findByRole("button", { name: /^Review 1/ });
  await tabTo(() => review, { back: true });
  await userEvent.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", { name: "Submit review" });
  expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Summary (optional)" }));
  await userEvent.keyboard("Thanks!");
  await tabTo(() => within(dialog).getByRole("button", { name: "Submit review" }));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(posted.at(-1)?.url).toBe(`${WRITE}/review`));
  expect(posted.at(-1)!.body).toMatchObject({ body: "Thanks!", event: "COMMENT" });
  await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Submit review" })).toBeNull());
  expect(draft.isConnected).toBe(false);

  // Reply to the thread, then resolve it.
  await tabTo(() => within(card).queryByRole("button", { name: /^Reply to thread by hamishwillee/ }));
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(within(card).getByRole("textbox", { name: /^Reply to thread/ }));
  await userEvent.keyboard("Agreed.");
  await tabTo(() => within(card).getByRole("button", { name: "Reply" }));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ url: `${WRITE}/reply`, body: { body: "Agreed." } }));
  threads(true);
  await tabTo(() => within(card).queryByRole("button", { name: /^Resolve thread by hamishwillee/ }));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ url: `${WRITE}/resolve`, body: { resolved: true } }));
  await screen.findByLabelText(/^Resolved thread by hamishwillee/);

  // Switch to the revision the outdated thread was written on.
  const revision = screen.getByRole("combobox", { name: "Revision" });
  await tabTo(() => revision, { back: true });
  await userEvent.selectOptions(revision, LINTED);
  await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ rev: LINTED }));
  expect(await screen.findByRole("status", { name: "Historical revision" })).toBeTruthy();
});

it("tabs into the document itself, so any text can be selected from the keyboard", async () => {
  renderPage().navigate({ to: ".", search: { doc: INDEX } });
  const article = await screen.findByRole("article", { name: "Rendered document" });
  await tabTo(() => article);
  await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
  expect(document.getSelection()!.toString()).toHaveLength(2);
  expect(await screen.findByRole("toolbar", { name: "Selection actions" })).toBeTruthy();
});
