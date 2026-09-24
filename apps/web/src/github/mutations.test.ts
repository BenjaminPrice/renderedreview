// SPDX-License-Identifier: AGPL-3.0-only
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizePublicComments } from "../ui/Viewer";
import { commentMutation, PublishError, replyMutation, resolveMutation, reviewMutation } from "./mutations";
import { issueCommentsQuery, type PrIdentity, reviewCommentsQuery, reviewsQuery, reviewThreadsQuery } from "./queries";

vi.mock("../ui/Viewer", () => ({ authorizePublicComments: vi.fn(async () => {}) }));

const HEAD = "a".repeat(40);
const id: PrIdentity = {
  host: "github.com",
  repositoryId: 1,
  ownerId: 2,
  owner: "acme",
  repo: "widgets",
  number: 7,
  headSha: HEAD,
  baseSha: "b".repeat(40),
  access: "user",
};

function setup(response: Response) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response);
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const run = <V>(options: object, variables: V) =>
    new MutationObserver(client, options as never).mutate(variables as never);
  const invalidated = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  const request = () => ({ url: fetch.mock.calls[0]![0], init: fetch.mock.calls[0]![1] });
  return { run, invalidated, request };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("publish mutations", () => {
  it("posts a comment as same-origin JSON with the head it was composed against", async () => {
    const { run, request, invalidated } = setup(Response.json({ comment: { id: 1 } }, { status: 201 }));
    const result = await run(commentMutation(id), { representation: "review-file", path: "docs/a.md", body: "Hi" });
    expect(result).toEqual({ comment: { id: 1 } });
    const { url, init } = request();
    expect(url).toBe("/api/github/write/github.com/acme/widgets/pulls/7/comment");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-requested-with")).toBe("rendered-review");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      expectedHeadOid: HEAD,
      representation: "review-file",
      path: "docs/a.md",
      body: "Hi",
    });
    expect(invalidated()).toEqual([reviewCommentsQuery(id).queryKey, reviewThreadsQuery(id).queryKey]);
  });

  it("refreshes PR conversation comments after a conversation comment", async () => {
    const { run, invalidated } = setup(Response.json({ comment: { id: 1 } }, { status: 201 }));
    await run(commentMutation(id), { representation: "conversation", body: "Hi" });
    expect(invalidated()).toEqual([issueCommentsQuery(id).queryKey]);
  });

  it("refreshes review threads after a reply or a resolution", async () => {
    const reply = setup(Response.json({ comment: { id: 2 } }, { status: 201 }));
    await reply.run(replyMutation(id), { inReplyTo: 1, body: "Done" });
    expect(reply.invalidated()).toEqual([reviewCommentsQuery(id).queryKey, reviewThreadsQuery(id).queryKey]);

    const resolve = setup(Response.json({ thread: { nodeId: "T", isResolved: true } }));
    await resolve.run(resolveMutation(id), { threadNodeId: "T", resolved: true });
    expect(resolve.request().url).toMatch(/\/pulls\/7\/resolve$/);
    expect(resolve.invalidated()).toEqual([reviewThreadsQuery(id).queryKey]);
  });

  it("refreshes everything a review can touch, even when some drafts failed", async () => {
    const body = { ok: false, results: [{ draftId: "d1", ok: false, error: { code: "github-error" } }] };
    const { run, invalidated, request } = setup(Response.json(body));
    const result = await run(reviewMutation(id), {
      submissionId: "s1",
      event: "COMMENT",
      drafts: [{ id: "d1", representation: "conversation", body: "x" }],
    });
    expect(result).toEqual(body);
    expect(JSON.parse(request().init.body as string)).toMatchObject({ expectedHeadOid: HEAD, submissionId: "s1" });
    expect(invalidated()).toEqual([
      reviewsQuery(id).queryKey,
      reviewCommentsQuery(id).queryKey,
      reviewThreadsQuery(id).queryKey,
      issueCommentsQuery(id).queryKey,
    ]);
  });

  it("throws a typed error carrying what the UI needs", async () => {
    const { run, invalidated } = setup(
      Response.json({ code: "github-rejected", message: "Validation Failed", retryAs: "review-file" }, { status: 422 }),
    );
    const error = await run(commentMutation(id), {
      representation: "review-line",
      path: "a.md",
      line: 1,
      side: "RIGHT",
      body: "x",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishError);
    expect(error).toMatchObject({
      status: 422,
      code: "github-rejected",
      retryAs: "review-file",
      message: "Validation Failed",
    });
    expect(invalidated()).toEqual([]);
  });

  it("refreshes the PR's head when it moved on", async () => {
    const { run, invalidated } = setup(
      Response.json({ code: "stale-head", message: "New commits", headOid: "c".repeat(40) }, { status: 409 }),
    );
    const error = await run(commentMutation(id), { representation: "conversation", body: "x" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "stale-head", headOid: "c".repeat(40) });
    expect(invalidated()).toEqual([["github", "user", "github.com", "pull"]]);
  });

  it("starts the public-comment authorization when the OAuth App is not linked", async () => {
    const { run } = setup(Response.json({ code: "needs-public-authorization", message: "Allow" }, { status: 403 }));
    await run(commentMutation(id), { representation: "conversation", body: "x" }).catch(() => {});
    expect(authorizePublicComments).toHaveBeenCalledOnce();
  });

  it("reports an unreadable failure as a network error", async () => {
    const { run } = setup(new Response("<html>Bad gateway</html>", { status: 502 }));
    const error = await run(commentMutation(id), { representation: "conversation", body: "x" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ status: 502, code: "github-error" });
  });
});
