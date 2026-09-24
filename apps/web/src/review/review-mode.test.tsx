// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Commenting on the review page end to end: selection → composer → draft or publish, the Review
// button and dialog, stale drafts. GitHub reads come from the mdn/content#45377 recording; writes
// go to the app's write boundary, answered here.
import { readFileSync } from "node:fs";
import { extractAnnotation } from "@rendered-review/annotation-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserCache } from "../github/client";
import { routeTree } from "../routeTree.gen";
import { allowedHostsQuery } from "../routes/$host.$owner.$repo.pull.$number";
import { Route as RootRoute } from "../routes/__root";
import type { Draft } from "./drafts";

const fixture = (name: string) => readFileSync(`${import.meta.dirname}/../document/fixtures/${name}`, "utf8");
const HEAD = "db23e1ea65fa47a95d8414d2d8be806a26dccf49";
const BASE = "358daf81ac9cf3db999cc8af7aed81ef4ff0c3f6";
const OLD = "0123456789abcdef0123456789abcdef01234567";
const REPO_ID = 295774370;
const INDEX = "files/en-us/web/http/reference/status/index.md";
const INDEX_BLOB = "1a05f7e9c35e2bb310563708351758307f34a599";
const API = "https://api.github.com/repos/mdn/content";
const WRITE = "/api/github/write/github.com/mdn/content/pulls/45377";

let responses: Record<string, string | Response>;
let posted: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  posted = [];
  responses = {
    "/api/auth/viewer": '{"login":"octocat","avatarUrl":null}',
    [`${API}/pulls/45377`]: fixture("pull.json"),
    [`${API}/pulls/45377/files?per_page=100`]: fixture("files.json"),
    [`${API}/pulls/45377/comments?per_page=100`]: "[]",
    [`${API}/pulls/45377/reviews?per_page=100`]: "[]",
    [`${API}/issues/45377/comments?per_page=100`]: "[]",
    [`${API}/pulls/45377/review-threads`]: "[]",
    [`${API}/contents/${INDEX}?ref=${BASE}`]: fixture("blob-4e1326aa2512d4d8eec8533471eee0dc684de810.md"),
    [`${API}/git/blobs/${INDEX_BLOB}`]: fixture(`blob-${INDEX_BLOB}.md`),
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST") posted.push({ url, body: JSON.parse(String(init.body)) });
    const body = responses[url.replace("/api/github/user/github.com/", "https://api.github.com/")];
    if (body instanceof Response) return body.clone();
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
    history: createMemoryHistory({
      initialEntries: [`/github.com/mdn/content/pull/45377?doc=${encodeURIComponent(INDEX)}`],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Select `word` inside the first text node containing `context`, and ask to comment on it. */
async function commentOn(context: string, word: string) {
  const article = await screen.findByRole("article", { name: "Rendered document" });
  await vi.waitFor(() => expect(article.textContent).toContain(context));
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let text: Text | null = null;
  while (!text && walker.nextNode())
    if ((walker.currentNode as Text).data.includes(context)) text = walker.currentNode as Text;
  const from = text!.data.indexOf(word);
  document.getSelection()!.setBaseAndExtent(text!, from, text!, from + word.length);
  article.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  const actions = await screen.findByRole("toolbar", { name: "Selection actions" });
  await userEvent.click(within(actions).getByRole("button", { name: /Comment/ }));
  return { article, composer: await screen.findByRole("region", { name: "New comment" }) };
}

const reviewButton = () => screen.findByRole("button", { name: /^Review/ });

it("signed out, the composer offers sign-in instead of a comment box", async () => {
  responses["/api/auth/viewer"] = "null";
  renderPage();
  const { composer } = await commentOn("Responses are grouped", "grouped");
  expect(within(composer).getByText("grouped")).toBeTruthy();
  expect(within(composer).getByRole("button", { name: "Sign in to comment" })).toBeTruthy();
  expect(within(composer).queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();
});

it("says how a comment will post: native on diff lines, file comment elsewhere in a changed file", async () => {
  renderPage();
  let { composer } = await commentOn("This interim response indicates", "interim response");
  expect(
    within(composer)
      .getByText(/in this PR's diff/)
      .closest("p")!.textContent,
  ).toBe("Will post as native review comment · line 26 is in this PR's diff");
  await userEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
  ({ composer } = await commentOn("Responses are grouped", "grouped"));
  expect(
    within(composer)
      .getByText(/isn't in the diff/)
      .closest("p")!.textContent,
  ).toBe("Will post as file comment · line 10 isn't in the diff");
});

it("highlights the selection being commented on until the composer closes", async () => {
  renderPage();
  const { article, composer } = await commentOn("Responses are grouped", "grouped");
  // No CSS Custom Highlight API here: the fallback marks the selected blocks.
  const marked = article.querySelectorAll("[data-rr-pending]");
  expect([...marked].map((el) => el.textContent)).toEqual([expect.stringContaining("Responses are grouped")]);
  await userEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
  expect(article.querySelectorAll("[data-rr-pending]")).toHaveLength(0);
});

it("adds drafts to the review and submits them with a summary and verdict", async () => {
  renderPage();
  const { composer } = await commentOn("Responses are grouped", "grouped");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "Grouped how?");
  await userEvent.click(within(composer).getByRole("button", { name: "Add to review" }));

  const draft = await screen.findByRole("region", { name: "Draft comment on line 10" });
  expect(within(draft).getByText("Grouped how?")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "New comment" })).toBeNull();
  expect((await reviewButton()).textContent).toMatch(/Review\s*1/);

  await userEvent.click(await reviewButton());
  const dialog = screen.getByRole("dialog", { name: "Submit review" });
  expect(within(dialog).getByRole("group", { name: /^File comments/ }).textContent).toContain("Grouped how?");
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Summary (optional)" }), "Thanks!");
  await userEvent.click(within(dialog).getByRole("radio", { name: "Approve" }));
  const pending = posted.length;
  vi.stubGlobal("fetch", wrapReview(globalThis.fetch));
  await userEvent.click(within(dialog).getByRole("button", { name: "Submit review" }));

  await vi.waitFor(() => expect(posted.length).toBe(pending + 1));
  const sent = posted.at(-1)!;
  expect(sent.url).toBe(`${WRITE}/review`);
  expect(sent.body).toMatchObject({ event: "APPROVE", body: "Thanks!", expectedHeadOid: HEAD });
  expect(sent.body.submissionId).toMatch(/^[\w-]+$/);
  const [d] = sent.body.drafts as Record<string, unknown>[];
  expect(d).toMatchObject({ representation: "review-file", path: INDEX, expectedHeadOid: HEAD });
  const decoded = extractAnnotation(String(d!.body));
  expect(decoded.status).toBe("ok");
  if (decoded.status !== "ok") return;
  expect(decoded.annotation.target).toMatchObject({
    githubHost: "github.com",
    repositoryId: REPO_ID,
    repository: "mdn/content",
    pullRequest: 45377,
    path: INDEX,
    commitOid: HEAD,
    blobOid: INDEX_BLOB,
  });
  expect(decoded.annotation.target.selectors).toContainEqual(
    expect.objectContaining({ type: "TextQuoteSelector", exact: "grouped" }),
  );
  expect(decoded.annotation.target.selectors).toContainEqual(
    expect.objectContaining({ type: "MarkdownSourceRangeSelector", startLine: 10, endLine: 10 }),
  );
  expect(String(d!.body)).toMatch(/^> grouped\n\nGrouped how\?\n\nDocument: /);

  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Draft comment on line 10" })).toBeNull());
  expect(screen.queryByRole("dialog", { name: "Submit review" })).toBeNull();
});

/** Answers review submissions with an ok result for every draft sent. */
function wrapReview(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!String(input).endsWith("/review")) return res;
    const { drafts } = JSON.parse(String(init!.body)) as { drafts: { id: string }[] };
    return Response.json({ ok: true, results: drafts.map((d) => ({ draftId: d.id, ok: true })) });
  };
}

it("publishes a comment now, and explains a refusal without losing the text", async () => {
  renderPage();
  const { composer } = await commentOn("This interim response indicates", "interim response");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "Which client?");
  responses[`${WRITE}/comment`] = new Response(
    JSON.stringify({ code: "stale-head", message: "The pull request head changed", headOid: OLD }),
    { status: 409 },
  );
  await userEvent.click(within(composer).getByRole("button", { name: "Comment now" }));
  expect((await within(composer).findByRole("alert")).textContent).toMatch(/new commits/);
  expect(within(composer).getByRole("textbox", { name: "Comment" })).toHaveProperty("value", "Which client?");
  expect(posted.at(-1)!.body).toMatchObject({
    representation: "review-line",
    path: INDEX,
    line: 26,
    side: "RIGHT",
    expectedHeadOid: HEAD,
  });

  responses[`${WRITE}/comment`] = JSON.stringify({ comment: { id: 1 } });
  await userEvent.click(within(composer).getByRole("button", { name: "Comment now" }));
  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "New comment" })).toBeNull());
});

it("retries a line comment GitHub refuses as a file comment", async () => {
  renderPage();
  const { composer } = await commentOn("This interim response indicates", "interim response");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "Which client?");
  responses[`${WRITE}/comment`] = new Response(
    JSON.stringify({ code: "github-rejected", message: "Line not in diff", retryAs: "review-file" }),
    { status: 422 },
  );
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    if (JSON.parse(String(init?.body ?? "{}")).representation === "review-file")
      return Response.json({ comment: { id: 2 } });
    return res;
  });
  await userEvent.click(within(composer).getByRole("button", { name: "Comment now" }));
  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "New comment" })).toBeNull());
  const retry = posted.at(-1)!.body;
  expect(retry).toMatchObject({ representation: "review-file", path: INDEX });
  expect(retry).not.toHaveProperty("line");
  expect(String(retry.body)).toContain("Document: ");
});

it("marks drafts from an older head stale and asks before publishing them", async () => {
  const old: Partial<Draft> = {
    id: "old-1",
    headOid: OLD,
    path: INDEX,
    comment: "Written earlier",
    body: "> grouped\n\nWritten earlier",
    representation: { kind: "review-file", reason: "Will post as file comment · line 10 isn't in the diff" },
    selection: {
      exact: "grouped",
      prefix: "",
      suffix: "",
      textPosition: { start: 0, end: 7 },
      sourceRange: { startLine: 10, startColumn: 11, endLine: 10, endColumn: 18 },
      nodeType: "paragraph",
      headingPath: [],
      blockIds: [],
      expanded: false,
    },
  };
  await browserCache.set("drafts", `github.com/${REPO_ID}/45377`, [old], { private: false });
  renderPage();
  const card = await screen.findByRole("region", { name: "Draft comment on line 10" });
  expect(within(card).getByText("Stale")).toBeTruthy();

  await userEvent.click(await reviewButton());
  const dialog = screen.getByRole("dialog", { name: "Submit review" });
  const submit = within(dialog).getByRole("button", { name: "Submit review" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /Publish stale drafts anyway/ }));
  expect(submit.hasAttribute("disabled")).toBe(false);
});

it("edits and deletes a draft", async () => {
  vi.stubGlobal("confirm", () => true);
  renderPage();
  const { composer } = await commentOn("Responses are grouped", "grouped");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "First");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  let card = await screen.findByRole("region", { name: "Draft comment on line 10" });
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("region", { name: "Edit draft" });
  await userEvent.type(within(editor).getByRole("textbox", { name: "Comment" }), " and second");
  await userEvent.click(within(editor).getByRole("button", { name: "Save draft" }));
  card = await screen.findByRole("region", { name: "Draft comment on line 10" });
  expect(within(card).getByText("First and second")).toBeTruthy();
  expect(await browserCache.get<Draft[]>("drafts", `github.com/${REPO_ID}/45377`)).toEqual([
    expect.objectContaining({ comment: "First and second", body: expect.stringContaining("First and second") }),
  ]);

  await userEvent.click(within(card).getByRole("button", { name: "Delete" }));
  expect(screen.queryByRole("region", { name: "Draft comment on line 10" })).toBeNull();
  expect((await reviewButton()).textContent).toMatch(/Review\s*0/);
});
