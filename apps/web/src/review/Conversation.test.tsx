// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import type { IssueComment, Review } from "@rendered-review/github-integration";
import { conversation } from "@rendered-review/review-domain";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationPanel, ReviewSummaries } from "./Conversation";
import { expectNewTab } from "../test-utils";
import { HEAD, repository } from "./fixtures";

// The link comment the GitHub Action posts: this marker, written by the Actions bot.
const MARKER = "<!-- rendered-review-link:v1 -->";
const ACTIONS_BOT = "github-actions[bot]";

afterEach(cleanup);

const actor = (login: string, type = "User") => ({ login, id: 1, nodeId: "U", type });

function issueComment(id: number, body: string, login = "alice"): IssueComment {
  return {
    id,
    nodeId: `IC${id}`,
    body,
    author: actor(login),
    authorAssociation: "MEMBER",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    htmlUrl: `https://github.com/acme/docs/pull/7#issuecomment-${id}`,
  };
}

describe("ConversationPanel", () => {
  it("labels permalinked ranges as inferred locations, and leaves branch links alone", () => {
    const entries = conversation(
      [
        issueComment(1, `See https://github.com/acme/docs/blob/${HEAD}/docs/guide.md#L3-L5`),
        issueComment(2, "See https://github.com/acme/docs/blob/main/docs/guide.md#L3"),
      ],
      repository,
    );
    render(<ConversationPanel entries={entries} repository={repository} />);
    const [first, second] = screen.getAllByRole("article");
    expect(within(first!).getByText("Inferred location")).toBeTruthy();
    const link = within(first!).getByRole("link", { name: /docs\/guide\.md · L3–L5 @/ });
    expect(link.getAttribute("href")).toBe(`https://github.com/acme/docs/blob/${HEAD}/docs/guide.md#L3-L5`);
    expectNewTab(link);
    expectNewTab(within(first!).getByRole("link", { name: "View on GitHub (opens in new tab)" }));
    expect(within(second!).queryByText("Inferred location")).toBeNull();
  });

  it("excludes the Rendered Review link comment, but not a human's comment with the marker", () => {
    const entries = conversation(
      [
        issueComment(1, `${MARKER}\nOpen in Rendered Review`, ACTIONS_BOT),
        issueComment(2, `${MARKER}\nquoting the bot`, "bob"),
        issueComment(3, "Plain comment"),
      ],
      repository,
    );
    render(<ConversationPanel entries={entries} repository={repository} />);
    const panel = screen.getByRole("region", { name: /Conversation/ });
    expect(
      within(panel)
        .getAllByRole("article")
        .map((a) => a.getAttribute("aria-label")),
    ).toEqual(["Comment by bob", "Comment by alice"]);
    expect(within(panel).queryByText("Open in Rendered Review")).toBeNull();
    expect(screen.getByRole("heading", { name: "Conversation 2" })).toBeTruthy();
  });

  it("shows an empty state", () => {
    render(<ConversationPanel entries={[]} repository={repository} />);
    expect(screen.getByText("No conversation comments.")).toBeTruthy();
  });
});

function review(id: number, state: Review["state"], body = "Summary text"): Review {
  return {
    id,
    nodeId: `R${id}`,
    state,
    body,
    commitOid: HEAD,
    submittedAt: "2026-01-01T00:00:00Z",
    author: actor(`user${id}`),
    authorAssociation: "MEMBER",
    htmlUrl: `https://github.com/acme/docs/pull/7#pullrequestreview-${id}`,
  };
}

describe("ReviewSummaries", () => {
  it("shows each verdict as text, with the body and a GitHub link", () => {
    render(
      <ReviewSummaries
        reviews={[
          review(1, "APPROVED", "Ship it"),
          review(2, "CHANGES_REQUESTED"),
          review(3, "COMMENTED"),
          review(4, "DISMISSED"),
        ]}
      />,
    );
    const articles = screen.getAllByRole("article");
    expect(articles.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Approved by user1",
      "Changes requested by user2",
      "Commented by user3",
      "Dismissed by user4",
    ]);
    expect(within(articles[0]!).getByText("Approved")).toBeTruthy();
    expect(within(articles[0]!).getByText("Ship it")).toBeTruthy();
    const link = within(articles[0]!).getByRole("link", { name: "View on GitHub (opens in new tab)" });
    expectNewTab(link);
    expect(link.getAttribute("href")).toBe("https://github.com/acme/docs/pull/7#pullrequestreview-1");
  });

  it("shows an empty state", () => {
    render(<ReviewSummaries reviews={[]} />);
    expect(screen.getByText("No review summaries.")).toBeTruthy();
  });
});
