// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Replying to and resolving threads through the write boundary: what is sent for native and
// application threads, and what the reviewer is told.
import {
  composeCommentBody,
  extractAnnotation,
  type RenderedReviewAnnotationV1,
} from "@rendered-review/annotation-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrIdentity } from "../github/queries";
import { comment, HEAD, lineAnchor, thread } from "./fixtures";
import { useThreadActions } from "./thread-actions";

vi.mock("../ui/Viewer", () => ({ authorizePublicComments: vi.fn(async () => {}) }));

const id: PrIdentity = {
  host: "github.com",
  repositoryId: 42,
  ownerId: 2,
  owner: "acme",
  repo: "docs",
  number: 7,
  headSha: HEAD,
  baseSha: "b".repeat(40),
  access: "user",
};
const WRITE = "/api/github/write/github.com/acme/docs/pulls/7";

const rootAnnotation: RenderedReviewAnnotationV1 = {
  version: 1,
  target: {
    githubHost: "github.com",
    repositoryId: 42,
    repository: "acme/docs",
    pullRequest: 7,
    path: "docs/guide.md",
    commitOid: HEAD,
    blobOid: "c".repeat(40),
    selectors: [
      { type: "TextQuoteSelector", exact: "full jitter", prefix: "", suffix: "" },
      { type: "TextPositionSelector", start: 10, end: 21 },
      { type: "MarkdownSourceRangeSelector", startLine: 3, startColumn: 1, endLine: 3, endColumn: 12 },
    ],
  },
  motivation: "commenting",
  createdBy: "rendered-review",
};

/** An application thread: a root conversation comment carrying an annotation, and one reply. */
function appThread(resolution: "resolved" | "unresolved" = "unresolved") {
  const root = comment({
    id: 1001,
    body: composeCommentBody({ annotation: rootAnnotation, comment: "Why jitter?", location: "conversation" }),
    htmlUrl: "https://github.com/acme/docs/pull/7#issuecomment-1001",
  });
  const reply = comment({ id: 1002, body: "Because." });
  return thread("app:1001", lineAnchor(3), resolution, [root, reply]);
}

function setup(response: () => Response = () => Response.json({}, { status: 201 })) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response());
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  const announce = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useThreadActions(id, { signedIn: true, announce }), { wrapper });
  const sent = () =>
    fetch.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body as string) as Record<string, unknown> }));
  return { actions: () => result.current, sent, announce };
}

const decode = (body: unknown) => {
  const extracted = extractAnnotation(body as string);
  if (extracted.status !== "ok") throw new Error(`no annotation: ${extracted.status}`);
  return extracted.annotation as RenderedReviewAnnotationV1 & { resolution?: string };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("replies", () => {
  it("replies to a native thread's root comment through the review reply API", async () => {
    const { actions, sent, announce } = setup();
    const t = thread("PRRT_1", lineAnchor(3), "unresolved", [comment({ id: 55 }), comment({ id: 56 })]);
    await actions().reply(t, "Agreed.");
    expect(sent()).toEqual([{ url: `${WRITE}/reply`, body: { inReplyTo: 55, body: "Agreed.", expectedHeadOid: HEAD } }]);
    expect(announce).toHaveBeenCalledWith("Reply posted");
  });

  it("replies to an application thread with a conversation comment linked to its root and parent", async () => {
    const { actions, sent } = setup();
    await actions().reply(appThread(), "Still unclear.");
    const [request] = sent();
    expect(request!.url).toBe(`${WRITE}/comment`);
    expect(request!.body).toMatchObject({ representation: "conversation", expectedHeadOid: HEAD });
    expect(request!.body.body).toContain("Still unclear.");
    // Readable on GitHub: the quote and the document link, as for the root.
    expect(request!.body.body).toContain("> full jitter");
    expect(request!.body.body).toContain("Document: [`docs/guide.md`]");
    const annotation = decode(request!.body.body);
    expect(annotation).toEqual({
      ...rootAnnotation,
      motivation: "replying",
      replyTo: "1002",
      threadId: "1001",
    });
  });

  it("explains a refusal in the reviewer's terms", async () => {
    const { actions, announce } = setup(() =>
      Response.json({ code: "rate-limited", message: "slow down" }, { status: 429 }),
    );
    await expect(actions().reply(thread("PRRT_1", lineAnchor(3)), "Hi")).rejects.toThrow(
      "GitHub's rate limit was reached. Try again later.",
    );
    expect(announce).not.toHaveBeenCalled();
  });

  it("refuses to reply to an application thread whose root metadata can't be read", async () => {
    const { actions, sent } = setup();
    const t = thread("app:9", lineAnchor(3), "unresolved", [comment({ id: 9, body: "no marker" })]);
    await expect(actions().reply(t, "Hi")).rejects.toThrow(/metadata/);
    expect(sent()).toEqual([]);
  });
});

describe("resolution", () => {
  it("resolves and reopens a native thread by its GraphQL node id", async () => {
    const { actions, sent, announce } = setup();
    await actions().setResolved(thread("PRRT_1", lineAnchor(3), "unresolved"), true);
    await actions().setResolved(thread("PRRT_1", lineAnchor(3), "resolved"), false);
    expect(sent()).toEqual([
      { url: `${WRITE}/resolve`, body: { threadNodeId: "PRRT_1", resolved: true } },
      { url: `${WRITE}/resolve`, body: { threadNodeId: "PRRT_1", resolved: false } },
    ]);
    expect(announce.mock.calls).toEqual([["Thread resolved"], ["Thread reopened"]]);
  });

  it("resolves and reopens an application thread with a visible conversation comment", async () => {
    const { actions, sent } = setup();
    await actions().setResolved(appThread("unresolved"), true);
    await actions().setResolved(appThread("resolved"), false);
    const [resolve, reopen] = sent();
    expect(resolve!.url).toBe(`${WRITE}/comment`);
    expect(resolve!.body).toMatchObject({ representation: "conversation", expectedHeadOid: HEAD });
    expect(resolve!.body.body).toContain(
      "Resolved [this thread](https://github.com/acme/docs/pull/7#issuecomment-1001).",
    );
    expect(decode(resolve!.body.body)).toEqual({
      ...rootAnnotation,
      motivation: "resolving",
      threadId: "1001",
      resolution: "resolved",
    });
    expect(reopen!.body.body).toContain("Reopened [this thread]");
    expect(decode(reopen!.body.body)).toMatchObject({ motivation: "resolving", resolution: "reopened" });
  });
});
