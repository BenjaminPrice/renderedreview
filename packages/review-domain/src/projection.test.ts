// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor, IssueComment, Review, ReviewComment, ReviewThread } from "@rendered-review/github-integration";
import { renderMarkdown } from "@rendered-review/markdown-domain";
import { describe, expect, it } from "vitest";
import {
  conversation,
  groupThreads,
  inferLocations,
  isIntegrationNotice,
  placeThreads,
  projectReview,
  reviewers,
  reviewSummaries,
  timeline,
  unresolvedByPath,
  type RepositoryRef,
} from "./projection.js";

const HEAD = "a".repeat(40);
const ORIG = "b".repeat(40);
const MARKER = "<!-- rendered-review-link:v1 -->";
const repo = { host: "github.com", owner: "acme", name: "docs" };

const user = (login: string, type = "User"): Actor => ({ login, id: 1, nodeId: "U", type });

let seq = 0;
const rc = (o: Partial<ReviewComment> = {}): ReviewComment => ({
  id: ++seq,
  nodeId: `RC${seq}`,
  reviewId: 1,
  inReplyToId: null,
  path: "doc.md",
  commitOid: HEAD,
  originalCommitOid: HEAD,
  line: 3,
  originalLine: 3,
  startLine: null,
  originalStartLine: null,
  side: "RIGHT",
  startSide: null,
  subjectType: "line",
  diffHunk: "",
  body: "comment",
  author: user("alice"),
  authorAssociation: "MEMBER",
  createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
  updatedAt: "2026-01-01T00:00:00Z",
  htmlUrl: "",
  ...o,
});

const ic = (body: string, author: Actor | null = user("alice")): IssueComment => ({
  id: ++seq,
  nodeId: `IC${seq}`,
  body,
  author,
  authorAssociation: "MEMBER",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  htmlUrl: "",
});

const rt = (ids: number[], isResolved: boolean): ReviewThread => ({
  nodeId: `PRRT_${ids[0]}`,
  isResolved,
  isOutdated: false,
  resolvedBy: null,
  path: "doc.md",
  line: 3,
  originalLine: 3,
  startLine: null,
  originalStartLine: null,
  diffSide: "RIGHT",
  subjectType: "LINE",
  commentIds: ids,
});

describe("groupThreads", () => {
  it("groups REST reply chains (including reply-to-reply) with unknown resolution", () => {
    const root = rc();
    const r1 = rc({ inReplyToId: root.id });
    const r2 = rc({ inReplyToId: r1.id });
    const other = rc({ line: 9 });
    const threads = groupThreads([r2, other, root, r1]);
    expect(threads.map((t) => [t.id, t.comments.map((c) => c.id), t.resolution])).toEqual([
      [`rest:${root.id}`, [root.id, r1.id, r2.id], "unknown"],
      [`rest:${other.id}`, [other.id], "unknown"],
    ]);
  });

  it("uses GraphQL threads for membership and resolution, REST for the rest", () => {
    const a = rc();
    const aReply = rc({ inReplyToId: a.id });
    const b = rc();
    const c = rc();
    const threads = groupThreads([a, aReply, b, c], [rt([a.id, aReply.id], true), rt([b.id], false)]);
    expect(threads.map((t) => [t.id, t.comments.length, t.resolution])).toEqual([
      [`PRRT_${a.id}`, 2, "resolved"],
      [`PRRT_${b.id}`, 1, "unresolved"],
      [`rest:${c.id}`, 1, "unknown"],
    ]);
  });

  it.each<[string, Partial<ReviewComment>, unknown]>([
    [
      "current single line",
      { line: 7 },
      { type: "current", kind: "github-line", side: "RIGHT", startLine: 7, endLine: 7, commitOid: HEAD },
    ],
    [
      "current range",
      { startLine: 6, line: 7, startSide: "RIGHT" },
      { type: "current", kind: "github-line", side: "RIGHT", startLine: 6, endLine: 7, commitOid: HEAD },
    ],
    [
      "outdated keeps original commit and lines",
      { line: null, originalStartLine: 4, originalLine: 5, originalCommitOid: ORIG },
      { type: "outdated", kind: "github-line", side: "RIGHT", startLine: 4, endLine: 5, commitOid: ORIG },
    ],
    [
      "LEFT side",
      { side: "LEFT", line: 2 },
      { type: "current", kind: "github-line", side: "LEFT", startLine: 2, endLine: 2, commitOid: HEAD },
    ],
    [
      "range starting on the other side keeps only its end line",
      { startSide: "LEFT", startLine: 2, side: "RIGHT", line: 5 },
      { type: "current", kind: "github-line", side: "RIGHT", startLine: 5, endLine: 5, commitOid: HEAD },
    ],
    ["file-level", { subjectType: "file", line: null, originalLine: null, side: null }, { type: "file" }],
  ])("anchor: %s", (_, fields, anchor) => {
    expect(groupThreads([rc(fields)])[0]!.anchor).toEqual(anchor);
  });
});

describe("placeThreads", () => {
  const head = renderMarkdown("# Title\n\nIntro.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nLast.\n");
  const base = renderMarkdown("# Title\n\nRemoved paragraph.\n");
  const place = (fields: Partial<ReviewComment>, path = "doc.md") =>
    placeThreads(groupThreads([rc(fields)]), path, { head, base }).map((p) => p.blocks.map((b) => b.type));

  it.each<[string, Partial<ReviewComment>, string[]]>([
    ["single line on a paragraph", { line: 3 }, ["paragraph"]],
    ["range inside a fence maps to the whole code block", { startLine: 6, line: 7 }, ["code"]],
    ["range across blocks", { startLine: 1, line: 3 }, ["heading", "paragraph"]],
    ["LEFT side maps against the base", { side: "LEFT", line: 3 }, ["paragraph"]],
    ["outdated is not placed", { line: null, originalLine: 3 }, []],
    ["file-level is not placed", { subjectType: "file", line: null }, []],
  ])("%s", (_, fields, types) => {
    expect(place(fields)).toEqual([types]);
  });

  it("LEFT side maps to base text, not head text", () => {
    const [p] = placeThreads(groupThreads([rc({ side: "LEFT", line: 3 })]), "doc.md", { head, base });
    expect(p!.blocks[0]!.text).toBe("Removed paragraph.");
  });

  it("skips other files and a missing base", () => {
    expect(place({ line: 3 }, "other.md")).toEqual([]);
    expect(placeThreads(groupThreads([rc({ side: "LEFT" })]), "doc.md", { head })[0]!.blocks).toEqual([]);
  });

  it("places a deleted file's LEFT side on the base and leaves RIGHT unplaced", () => {
    const threads = groupThreads([rc({ side: "LEFT", line: 3 }), rc({ side: "RIGHT", line: 3 })]);
    expect(placeThreads(threads, "doc.md", { base }).map((p) => p.blocks.map((b) => b.text))).toEqual([
      ["Removed paragraph."],
      [],
    ]);
  });
});

describe("integration notice exclusion", () => {
  it.each<[string, string, Actor | null, string[] | undefined, boolean]>([
    ["marker + actions bot", `${MARKER}\nOpen in Rendered Review`, user("github-actions[bot]", "Bot"), undefined, true],
    ["marker + configured app bot", MARKER, user("rendered-review[bot]", "Bot"), ["rendered-review[bot]"], true],
    ["marker + human", MARKER, user("alice"), undefined, false],
    ["marker + unknown bot", MARKER, user("dependabot[bot]", "Bot"), undefined, false],
    ["marker + ghost author", MARKER, null, undefined, false],
    ["actions bot without marker", "Build passed", user("github-actions[bot]", "Bot"), undefined, false],
    ["actions bot when only the app bot is expected", MARKER, user("github-actions[bot]", "Bot"), ["rr[bot]"], false],
  ])("%s", (_, body, author, bots, excluded) => {
    const c = ic(body, author);
    expect(isIntegrationNotice(c, bots)).toBe(excluded);
    expect(conversation([c], repo, bots).length).toBe(excluded ? 0 : 1);
  });
});

describe("inferLocations", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const base = `https://github.com/acme/docs/blob/${sha}/docs/guide.md`;
  const loc = (startLine: number, endLine: number, path = "docs/guide.md") => ({
    kind: "inferred",
    sha,
    path,
    startLine,
    endLine,
  });

  it.each<[string, string, RepositoryRef | undefined, unknown[]]>([
    ["single line", `See ${base}#L10.`, undefined, [loc(10, 10)]],
    ["range", `See ${base}#L10-L20`, undefined, [loc(10, 20)]],
    ["plain view with columns", `[x](${base}?plain=1#L3C2-L5C9)`, undefined, [loc(3, 5)]],
    ["encoded path", `https://github.com/acme/docs/blob/${sha}/a%20b.md#L1`, undefined, [loc(1, 1, "a b.md")]],
    [
      "owner/repo case-insensitive",
      `https://github.com/ACME/Docs/blob/${sha}/docs/guide.md#L2`,
      undefined,
      [loc(2, 2)],
    ],
    ["branch link is not immutable", "https://github.com/acme/docs/blob/main/docs/guide.md#L10", undefined, []],
    ["short sha is not canonical", "https://github.com/acme/docs/blob/0123456/docs/guide.md#L10", undefined, []],
    ["no line anchor", base, undefined, []],
    ["other repository", `https://github.com/evil/docs/blob/${sha}/docs/guide.md#L1`, undefined, []],
    ["other host", `https://gitlab.com/acme/docs/blob/${sha}/docs/guide.md#L1`, undefined, []],
    ["prose is never inferred", "See line 10 of docs/guide.md", undefined, []],
    [
      "GHES host",
      `https://ghe.corp.example/acme/docs/blob/${sha}/docs/guide.md#L4-L6`,
      { host: "ghe.corp.example", owner: "acme", name: "docs" },
      [loc(4, 6)],
    ],
    ["github.com link on a GHES repo", `${base}#L1`, { host: "ghe.corp.example", owner: "acme", name: "docs" }, []],
    ["several links", `${base}#L1 and ${base}#L7-L8`, undefined, [loc(1, 1), loc(7, 8)]],
  ])("%s", (_, body, r, expected) => {
    expect(inferLocations(body, r ?? repo)).toEqual(expected);
  });
});

describe("reviews and counts", () => {
  const review = (state: Review["state"], body: string, o: Partial<Review> = {}): Review => ({
    id: ++seq,
    nodeId: "R",
    state,
    body,
    commitOid: HEAD,
    submittedAt: state === "PENDING" ? null : "2026-01-01T00:00:00Z",
    author: user("alice"),
    ...o,
    authorAssociation: "MEMBER",
    htmlUrl: "",
  });

  it("keeps submitted reviews with a body", () => {
    const kept = [review("APPROVED", "LGTM"), review("CHANGES_REQUESTED", "Fix"), review("COMMENTED", "Hm")];
    expect(reviewSummaries([...kept, review("COMMENTED", "  "), review("PENDING", "draft")])).toEqual(kept);
  });

  it("counts threads not known to be resolved per path", () => {
    const a = rc();
    const b = rc();
    const c = rc({ path: "other.md" });
    expect(unresolvedByPath(groupThreads([a, b, c], [rt([a.id], true), rt([b.id], false)]))).toEqual({
      "doc.md": 1,
      "other.md": 1,
    });
  });

  it("projectReview wires it together and excludes the link comment everywhere", () => {
    const p = projectReview({
      repository: { ...repo, repositoryId: 42, pullRequest: 7 },
      reviewComments: [rc()],
      reviews: [review("APPROVED", "ok")],
      issueComments: [ic(MARKER, user("github-actions[bot]", "Bot")), ic("hello")],
    });
    expect(p.threads).toHaveLength(1);
    expect(p.summaries).toHaveLength(1);
    expect(p.conversation.map((e) => e.comment.body)).toEqual(["hello"]);
    expect(p.unresolvedByPath).toEqual({ "doc.md": 1 });
    expect(p.timeline.map((i) => i.kind)).toEqual(["comment", "review"]);
  });

  it("builds a time-ordered timeline of comments and review events, with each review's threads", () => {
    const at = (m: number) => `2026-01-01T00:0${m}:00Z`;
    const approved = review("APPROVED", "", { submittedAt: at(3) });
    const changes = review("CHANGES_REQUESTED", "Fix the cap", { submittedAt: at(1) });
    const lineOnly = review("COMMENTED", "", { submittedAt: at(2) });
    const summary = review("COMMENTED", "See threads", { submittedAt: at(4) });
    const pending = review("PENDING", "draft");
    const hello = { ...ic("hello"), createdAt: at(0) };
    const later = { ...ic("later"), createdAt: at(5) };
    const threads = groupThreads([rc({ reviewId: changes.id }), rc({ reviewId: lineOnly.id })]);
    const items = timeline(
      conversation([later, hello], repo),
      [approved, changes, lineOnly, summary, pending],
      threads,
    );
    expect(items.map((i) => (i.kind === "comment" ? i.entry.comment.body : i.review.state))).toEqual([
      "hello",
      "CHANGES_REQUESTED",
      "APPROVED",
      "COMMENTED",
      "later",
    ]);
    const first = items[1]!;
    expect(first.kind === "review" && first.threads.map((t) => (t.comments[0] as ReviewComment).reviewId)).toEqual([
      changes.id,
    ]);
  });

  it("lists each reviewer's latest verdict, excluding the author", () => {
    const at = (m: number) => `2026-01-01T00:0${m}:00Z`;
    const states = reviewers(
      [
        review("CHANGES_REQUESTED", "", { author: user("bob"), submittedAt: at(1) }),
        review("COMMENTED", "", { author: user("bob"), submittedAt: at(2) }),
        review("APPROVED", "", { author: user("carol"), submittedAt: at(1) }),
        review("DISMISSED", "", { author: user("carol"), submittedAt: at(2) }),
        review("COMMENTED", "", { author: user("dave"), submittedAt: at(1) }),
        review("COMMENTED", "", { author: user("alice"), submittedAt: at(1) }),
        review("PENDING", "", { author: user("erin") }),
      ],
      "alice",
    );
    expect(states.map((r) => [r.author.login, r.state])).toEqual([
      ["bob", "CHANGES_REQUESTED"],
      ["carol", "COMMENTED"],
      ["dave", "COMMENTED"],
    ]);
  });
});
