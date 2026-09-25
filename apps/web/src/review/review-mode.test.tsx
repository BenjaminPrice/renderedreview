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
async function commentOn(context: string, word: string, action: "Comment" | "Suggest" = "Comment") {
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
  await userEvent.click(within(actions).getByRole("button", { name: new RegExp(action) }));
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
  // Not silent: the rail says where it went, until dismissed or the next comment.
  const status = screen.getByRole("status", { name: "Publishing status" });
  expect(status.textContent).toMatch(/^Posted as a file comment · GitHub refused line 26 as a diff location/);
  await userEvent.click(within(status).getByRole("button", { name: "Dismiss" }));
  expect(status.textContent).toBe("");
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

it("turns review drafts GitHub refuses on their diff lines into file comments, keeping them", async () => {
  renderPage();
  const { composer } = await commentOn("This interim response indicates", "interim response");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "Which client?");
  await userEvent.click(within(composer).getByRole("button", { name: "Add to review" }));
  const card = await screen.findByRole("region", { name: "Draft comment on line 26" });
  expect(within(card).getByText("Will post as native review comment")).toBeTruthy();

  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/review")) return inner(input, init);
    await inner(input, init);
    const { drafts } = JSON.parse(String(init!.body)) as { drafts: { id: string }[] };
    const error = { code: "github-rejected", message: "Line could not be resolved", retryAs: "review-file" };
    return Response.json({ ok: false, results: drafts.map((d) => ({ draftId: d.id, ok: false, error })) });
  });
  await userEvent.click(await reviewButton());
  const dialog = screen.getByRole("dialog", { name: "Submit review" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Submit review" }));

  expect((await within(dialog).findByRole("alert")).textContent).toMatch(
    /0 published\. 1 not published:.*line 26: Line could not be resolved\. It is now a file comment; submit again to post it\./,
  );
  expect(within(dialog).getByRole("group", { name: /^File comments/ }).textContent).toContain("Which client?");
  const kept = screen.getByRole("region", { name: "Draft comment on line 26" });
  expect(within(kept).getByText("Will post as file comment")).toBeTruthy();
  const [saved] = (await browserCache.get<Draft[]>("drafts", `github.com/${REPO_ID}/45377`))!;
  expect(saved!.body).toContain("Document: ");
});

it("asks GitHub for public-repository comment permission when publishing needs it", async () => {
  renderPage();
  const { composer } = await commentOn("This interim response indicates", "interim response");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment" }), "Which client?");
  responses[`${WRITE}/comment`] = new Response(
    JSON.stringify({ code: "needs-public-authorization", message: "Authorize public comments" }),
    { status: 403 },
  );
  await userEvent.click(within(composer).getByRole("button", { name: "Comment now" }));
  expect((await within(composer).findByRole("alert")).textContent).toMatch(/permission to comment on public/);
  await vi.waitFor(() => expect(posted.map((p) => p.url)).toContain("/api/auth/link-social"));
  expect(posted.find((p) => p.url === "/api/auth/link-social")!.body).toMatchObject({ provider: "github-public" });
});

// hamishwillee's suggestion on index.md, moved onto head line 30 so its thread is current.
const SUGGESTION = 3945848286;
function suggestionThread(isResolved: boolean) {
  const comments = JSON.parse(fixture("review-comments.json")) as Record<string, unknown>[];
  Object.assign(
    comments.find((c) => c.id === SUGGESTION)!,
    { line: 30, commit_id: HEAD },
  );
  responses[`${API}/pulls/45377/comments?per_page=100`] = JSON.stringify(comments);
  responses[`${API}/pulls/45377/review-threads`] = JSON.stringify([
    {
      nodeId: "PRRT_suggestion",
      isResolved,
      isOutdated: false,
      resolvedBy: null,
      path: INDEX,
      line: 30,
      originalLine: 30,
      startLine: null,
      originalStartLine: null,
      diffSide: "RIGHT",
      subjectType: "LINE",
      commentIds: [SUGGESTION],
    },
  ]);
}
const suggestionCard = async () =>
  within(await screen.findByRole("complementary", { name: /Comments/ })).findByRole("region", {
    name: /GitHub line comment · L30, by hamishwillee/,
  });

it("replies to a review thread and resolves it, announcing each outcome", async () => {
  suggestionThread(false);
  renderPage();
  const card = await suggestionCard();
  await userEvent.click(within(card).getByRole("button", { name: /^Reply to thread by hamishwillee/ }));
  responses[`${WRITE}/reply`] = JSON.stringify({ comment: { id: 1 } });
  await userEvent.type(within(card).getByRole("textbox", { name: "Reply to thread by hamishwillee" }), "Agreed.");
  await userEvent.click(within(card).getByRole("button", { name: "Reply" }));
  const status = screen.getByRole("status", { name: "Publishing status" });
  await vi.waitFor(() => expect(status.textContent).toContain("Reply posted"));
  expect(posted.at(-1)).toEqual({
    url: `${WRITE}/reply`,
    body: { inReplyTo: SUGGESTION, body: "Agreed.", expectedHeadOid: HEAD },
  });

  responses[`${WRITE}/resolve`] = JSON.stringify({ thread: { nodeId: "PRRT_suggestion", isResolved: true } });
  suggestionThread(true);
  await userEvent.click(within(card).getByRole("button", { name: /^Resolve thread by hamishwillee/ }));
  await vi.waitFor(() => expect(status.textContent).toContain("Thread resolved"));
  expect(posted.at(-1)).toEqual({
    url: `${WRITE}/resolve`,
    body: { threadNodeId: "PRRT_suggestion", resolved: true },
  });
  // Refetched as resolved: the thread collapses in place.
  expect(await screen.findByLabelText(/^Resolved thread by hamishwillee/)).toBeTruthy();
});

it("signed out, thread cards offer sign-in instead of reply and resolve", async () => {
  responses["/api/auth/viewer"] = "null";
  suggestionThread(false);
  renderPage();
  const card = await suggestionCard();
  expect(within(card).getByRole("button", { name: "Sign in to reply" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: /^(Reply|Resolve)/ })).toBeNull();
});

const LINE_26 =
  "  - : This interim response indicates that the client should continue the request or ignore the response if the request is already finished.";

it("suggests a change to diff lines, from the selection toolbar, as a native suggestion", async () => {
  renderPage();
  const { composer } = await commentOn("This interim response indicates", "interim response", "Suggest");
  expect(within(composer).getByRole("button", { name: "Suggest" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(composer).getByText("Suggesting a replacement for line 26")).toBeTruthy();
  const replacement = within(composer).getByRole("textbox", { name: "Replacement" });
  expect(replacement).toHaveProperty("value", LINE_26);
  expect(within(composer).getByText(/authors can apply it on GitHub/)).toBeTruthy();

  await userEvent.clear(replacement);
  await userEvent.type(replacement, "  - : This interim response tells the client to continue.");
  responses[`${WRITE}/comment`] = JSON.stringify({ comment: { id: 1 } });
  await userEvent.click(within(composer).getByRole("button", { name: "Comment now" }));
  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "New comment" })).toBeNull());

  const sent = posted.at(-1)!.body;
  expect(sent).toMatchObject({ representation: "review-line", path: INDEX, line: 26, side: "RIGHT" });
  expect(sent).not.toHaveProperty("startLine");
  expect(String(sent.body)).toMatch(
    /^```suggestion\n {2}- : This interim response tells the client to continue\.\n```\n\n<!-- rendered-review:v1:/,
  );
  const decoded = extractAnnotation(String(sent.body));
  expect(decoded.status === "ok" && decoded.annotation.motivation).toBe("suggesting");
});

it("adds a suggestion outside the diff to the review and submits it as a proposed change to apply manually", async () => {
  renderPage();
  const { composer } = await commentOn("Responses are grouped", "grouped");
  await userEvent.click(within(composer).getByRole("button", { name: "Suggest" }));
  expect(within(composer).getByText(/it must be applied manually/)).toBeTruthy();
  const replacement = within(composer).getByRole("textbox", { name: "Replacement" });
  await userEvent.clear(replacement);
  await userEvent.type(replacement, "Responses fall into five classes:");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Comment (optional)" }), "Simpler.");
  await userEvent.click(within(composer).getByRole("button", { name: "Add to review" }));

  const draft = await screen.findByRole("region", { name: "Draft suggestion on line 10" });
  expect(within(draft).getByRole("group", { name: "Suggested change" }).textContent).toContain(
    "Responses fall into five classes:",
  );

  await userEvent.click(await reviewButton());
  const dialog = screen.getByRole("dialog", { name: "Submit review" });
  vi.stubGlobal("fetch", wrapReview(globalThis.fetch));
  await userEvent.click(within(dialog).getByRole("radio", { name: "Approve" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Submit review" }));
  await vi.waitFor(() => expect(posted.at(-1)?.url).toBe(`${WRITE}/review`));

  const [d] = posted.at(-1)!.body.drafts as Record<string, unknown>[];
  expect(d).toMatchObject({ representation: "review-file", path: INDEX });
  const body = String(d!.body);
  expect(body).toMatch(/^> grouped\n\nSimpler\.\n\n\*\*Suggested change\*\* \(apply it manually/);
  expect(body).toContain("```diff\n-Responses are grouped in five classes:\n+Responses fall into five classes:\n```");
  const decoded = extractAnnotation(body);
  expect(decoded.status === "ok" && decoded.annotation.motivation).toBe("suggesting");
});

it("retries a native suggestion GitHub refuses on its line as a proposed change on the file", async () => {
  renderPage();
  const { composer } = await commentOn("This interim response indicates", "interim response", "Suggest");
  await userEvent.type(within(composer).getByRole("textbox", { name: "Replacement" }), "!");
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
  const retry = String(posted.at(-1)!.body.body);
  expect(retry).not.toContain("```suggestion");
  expect(retry).toContain(`\`\`\`diff\n-${LINE_26}\n+${LINE_26}!\n\`\`\``);
});

// Repairing the anchor of the viewer's own comment. octocat is GitHub user 583231.
const ME = { login: "octocat", id: 583231, node_id: "MDQ6VXNlcjU4MzIzMQ==", type: "User" };
const OWN = 1001;
const OTHERS = 1002;
const DAMAGED_BODY =
  "> This interim\r\n\r\nWhat does *interim* mean here?  \r\nAnd why?\r\n\r\n<!-- rendered-review:v1:not base64! -->";
function damagedComments(extra: (c: Record<string, unknown>) => void = () => {}) {
  const [template] = JSON.parse(fixture("review-comments.json")) as Record<string, unknown>[];
  const at = (id: number, user: object, body = DAMAGED_BODY) => ({
    ...template,
    id,
    node_id: `PRRC_${id}`,
    pull_request_review_id: 1,
    in_reply_to_id: null,
    path: INDEX,
    commit_id: HEAD,
    original_commit_id: HEAD,
    line: 26,
    original_line: 26,
    start_line: null,
    original_start_line: null,
    side: "RIGHT",
    subject_type: "line",
    body,
    user,
    created_at: "2026-09-07T00:00:00Z",
    updated_at: "2026-09-07T00:00:00Z",
    html_url: `https://github.com/mdn/content/pull/45377#discussion_r${id}`,
  });
  const comments = [at(OWN, ME), at(OTHERS, { ...ME, login: "hamishwillee", id: 5368500 })];
  extra(comments[0]!);
  responses[`${API}/pulls/45377/comments?per_page=100`] = JSON.stringify(comments);
}

/** Select `word` in the first text node containing `context`; returns the selection toolbar. */
async function select(context: string, word: string) {
  const article = await screen.findByRole("article", { name: "Rendered document" });
  await vi.waitFor(() => expect(article.textContent).toContain(context));
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  let text: Text | null = null;
  while (!text && walker.nextNode())
    if ((walker.currentNode as Text).data.includes(context)) text = walker.currentNode as Text;
  const from = text!.data.indexOf(word);
  document.getSelection()!.setBaseAndExtent(text!, from, text!, from + word.length);
  article.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return screen.findByRole("toolbar", { name: "Selection actions" });
}

const repairButton = (name: RegExp) =>
  within(screen.getByRole("complementary", { name: /Comments/ })).queryByRole("button", {
    name: new RegExp(`^Repair anchor of thread by ${name.source}`),
  });

it("repairs the anchor of the viewer's own damaged comment after previewing the change", async () => {
  responses["/api/auth/viewer"] = JSON.stringify({ login: "octocat", id: ME.id, avatarUrl: null });
  damagedComments();
  renderPage();
  await threadCardFor(/L26, by octocat/);
  // Offered on the viewer's comment only, by GitHub user id.
  expect(repairButton(/hamishwillee/)).toBeNull();
  await userEvent.click(repairButton(/octocat/)!);
  const status = screen.getByRole("status", { name: "Publishing status" });
  expect(status.textContent).toMatch(/Select the text/);

  const actions = await select("This interim response indicates", "interim response");
  expect(within(actions).queryByRole("button", { name: /^Comment/ })).toBeNull();
  await userEvent.click(within(actions).getByRole("button", { name: /Move comment here/ }));
  const preview = await screen.findByRole("region", { name: "Repair anchor" });
  expect(within(within(preview).getByRole("group", { name: "Quote" })).getByText("> interim response")).toBeTruthy();
  expect(within(preview).getByRole("group", { name: "Your comment, unchanged" }).textContent).toBe(
    "What does *interim* mean here?  \r\nAnd why?",
  );
  // Nothing is sent before the explicit confirmation.
  expect(posted.filter((p) => p.url.endsWith("/edit"))).toHaveLength(0);

  responses[`${WRITE}/edit`] = JSON.stringify({ comment: { id: OWN } });
  let sentBody = "";
  const answer = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/edit")) {
      sentBody = JSON.parse(String(init!.body)).body;
      // What GitHub lists afterwards.
      damagedComments((c) => (c.body = sentBody));
    }
    return answer(input, init);
  });
  await userEvent.click(within(preview).getByRole("button", { name: "Update comment" }));
  await vi.waitFor(() => expect(status.textContent).toContain("Comment anchor updated"));

  expect(posted.at(-1)).toEqual({
    url: `${WRITE}/edit`,
    body: {
      commentType: "review",
      commentId: OWN,
      previousBody: DAMAGED_BODY,
      body: sentBody,
      expectedHeadOid: HEAD,
    },
  });
  expect(sentBody.startsWith("> interim response\n\nWhat does *interim* mean here?  \r\nAnd why?\n\n<!--")).toBe(true);
  const decoded = extractAnnotation(sentBody);
  expect(decoded.status === "ok" && decoded.annotation.target).toMatchObject({
    path: INDEX,
    commitOid: HEAD,
    blobOid: INDEX_BLOB,
    selectors: expect.arrayContaining([
      expect.objectContaining({ type: "TextQuoteSelector", exact: "interim response" }),
    ]),
  });
  // Refetched: the card is placed at the new words, with nothing left to repair.
  expect(await threadCardFor(/^Selected text · L26, by octocat/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Repair anchor" })).toBeNull();
  expect(repairButton(/octocat/)).toBeNull();
});

it("refuses a new selection outside a line comment's GitHub lines, and cancels without changing the comment", async () => {
  responses["/api/auth/viewer"] = JSON.stringify({ login: "octocat", id: ME.id, avatarUrl: null });
  damagedComments();
  renderPage();
  await threadCardFor(/L26, by octocat/);
  await userEvent.click(repairButton(/octocat/)!);
  const actions = await select("Responses are grouped", "grouped");
  await userEvent.click(within(actions).getByRole("button", { name: /Move comment here/ }));
  const preview = await screen.findByRole("region", { name: "Repair anchor" });
  expect(preview.textContent).toMatch(/GitHub keeps this comment on L26/);
  expect(within(preview).getByRole("button", { name: "Update comment" })).toHaveProperty("disabled", true);
  await userEvent.click(within(preview).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("region", { name: "Repair anchor" })).toBeNull();
  expect(screen.getByRole("status", { name: "Publishing status" }).textContent).not.toMatch(/Select the text/);
  // Back to commenting: the selection toolbar offers Comment again.
  const again = await select("Responses are grouped", "grouped");
  expect(within(again).getByRole("button", { name: /^Comment/ })).toBeTruthy();
  expect(posted.filter((p) => p.url.endsWith("/edit"))).toHaveLength(0);
});

const threadCardFor = async (name: RegExp) =>
  within(await screen.findByRole("complementary", { name: /Comments/ })).findByRole("region", { name });
