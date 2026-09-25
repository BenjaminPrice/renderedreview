// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Replying to and resolving threads through the write boundary: what is sent for native and
// application threads, and what the reviewer is told.
import { composeCommentBody, extractAnnotation } from "@rendered-review/annotation-domain";
import { projectReview } from "@rendered-review/review-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrIdentity } from "../github/queries";
import { annotation, appThread, comment, HEAD, issueComment, lineAnchor, thread } from "./fixtures";
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

/** An application thread: a root conversation comment and one reply. */
const app = (resolution: "resolved" | "unresolved" = "unresolved") =>
  appThread([issueComment("Why jitter?", { id: 1001 }), issueComment("Because.", { id: 1002 })], { resolution });

function setup(
  response: () => Response = () => Response.json({}, { status: 201 }),
  who: { signedIn?: boolean; viewerId?: number; authorId?: number } = { signedIn: true },
) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response());
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  const announce = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useThreadActions(id, { signedIn: true, ...who, announce }), { wrapper });
  const sent = () =>
    fetch.mock.calls
      .filter(([, init]) => init.method === "POST")
      .map(([url, init]) => ({ url, body: JSON.parse(init.body as string) as Record<string, unknown> }));
  return { actions: () => result.current, sent, announce };
}

const decode = (body: unknown) => {
  const extracted = extractAnnotation(body as string);
  if (extracted.status !== "ok") throw new Error(`no annotation: ${extracted.status}`);
  return extracted.annotation;
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
    expect(sent()).toEqual([
      { url: `${WRITE}/reply`, body: { inReplyTo: 55, body: "Agreed.", expectedHeadOid: HEAD } },
    ]);
    expect(announce).toHaveBeenCalledWith("Reply posted");
  });

  it("replies to an application thread with a conversation comment linked to its root and parent", async () => {
    const { actions, sent } = setup();
    await actions().reply(app(), "Still unclear.");
    const [request] = sent();
    expect(request!.url).toBe(`${WRITE}/comment`);
    expect(request!.body).toMatchObject({ representation: "conversation", expectedHeadOid: HEAD });
    expect(request!.body.body).toContain("Still unclear.");
    // Readable on GitHub: the quote and the document link, as for the root.
    expect(request!.body.body).toContain("> retries failed requests");
    expect(request!.body.body).toContain("Document: [`docs/guide.md`]");
    expect(decode(request!.body.body)).toEqual({
      ...annotation(),
      motivation: "replying",
      replyTo: "1002",
      threadId: "1001",
      createdBy: "rendered-review",
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

  it("refuses to reply to an application thread without its root annotation", async () => {
    const { actions, sent } = setup();
    const t = appThread(undefined, { anchor: lineAnchor(3) });
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
    const open = app("unresolved");
    await actions().setResolved(open, true);
    await actions().setResolved(app("resolved"), false);
    const [resolve, reopen] = sent();
    expect(resolve!.url).toBe(`${WRITE}/comment`);
    expect(resolve!.body).toMatchObject({ representation: "conversation", expectedHeadOid: HEAD });
    expect(resolve!.body.body).toContain(`Resolved [this thread](${open.comments[0]!.htmlUrl}).`);
    expect(decode(resolve!.body.body)).toEqual({
      ...annotation(),
      motivation: "resolving",
      threadId: "1001",
      resolution: "resolved",
      createdBy: "rendered-review",
    });
    expect(reopen!.body.body).toContain("Reopened [this thread]");
    expect(decode(reopen!.body.body)).toMatchObject({ motivation: "resolving", resolution: "reopened" });
  });
});

describe("who is offered Resolve (GitHub: the pull request author and people with write access)", () => {
  const REPO = "/api/github/user/github.com/repos/acme/docs";
  const repo = (push: boolean) => () => Response.json({ id: 42, permissions: { admin: false, push, pull: true } });

  it("offers it to a viewer with write access, read from the repository's permissions for them", async () => {
    const { actions } = setup(repo(true), { signedIn: true, viewerId: 5, authorId: 9 });
    await waitFor(() => expect(actions().canResolve).toBe(true));
  });

  it("does not offer it to a viewer with only read access", async () => {
    const { actions } = setup(repo(false), { signedIn: true, viewerId: 5, authorId: 9 });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(REPO, expect.anything()));
    await act(async () => {});
    expect(actions().canResolve).toBe(false);
  });

  it("offers it to the pull request author without asking GitHub", () => {
    const { actions } = setup(repo(false), { signedIn: true, viewerId: 9, authorId: 9 });
    expect(actions().canResolve).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not offer it signed out", () => {
    const { actions } = setup(repo(true), { signedIn: false });
    expect(actions().canResolve).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("round trip", () => {
  it("reads posted replies and resolutions back into the same application thread", async () => {
    const { actions, sent } = setup();
    const context = { host: "github.com", owner: "acme", name: "docs", repositoryId: 42, pullRequest: 7 };
    const comments = [
      issueComment("", {
        id: 1001,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        body: composeCommentBody({ annotation: annotation(), comment: "Why jitter?", location: "conversation" }),
      }),
    ];
    const current = () => {
      const threads = projectReview({
        repository: context,
        reviewComments: [],
        reviews: [],
        issueComments: comments,
      }).threads;
      expect(threads).toHaveLength(1);
      return threads[0]!;
    };
    // What GitHub stores for the last posted body, a minute after the previous comment.
    const stored = () => {
      const n = comments.length;
      const at = `2026-01-01T00:0${n}:00Z`;
      comments.push(
        issueComment("", { id: 1001 + n, createdAt: at, updatedAt: at, body: sent().at(-1)!.body.body as string }),
      );
    };

    await actions().reply(current(), "Still unclear.");
    stored();
    expect(current()).toMatchObject({ id: "app:1001", resolution: "unresolved" });
    expect(current().comments.map((c) => c.id)).toEqual([1001, 1002]);
    expect(current().metadata?.[1002]?.state).toBe("valid");

    await actions().setResolved(current(), true);
    stored();
    expect(current().resolution).toBe("resolved");
    expect(current().comments.map((c) => c.id)).toEqual([1001, 1002]);

    await actions().setResolved(current(), false);
    stored();
    expect(current().resolution).toBe("unresolved");
    expect(current().events?.map((e) => [e.comment.id, e.resolution])).toEqual([
      [1003, "resolved"],
      [1004, "reopened"],
    ]);

    await actions().reply(current(), "Thanks, clear now.");
    stored();
    expect(current().comments.map((c) => c.id)).toEqual([1001, 1002, 1005]);
    expect(
      projectReview({ repository: context, reviewComments: [], reviews: [], issueComments: comments }).conversation,
    ).toEqual([]);
  });
});
