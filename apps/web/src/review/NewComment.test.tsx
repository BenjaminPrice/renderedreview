// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The Overview's "Add a comment" box: a plain PR conversation comment through the write boundary.
import { extractAnnotation } from "@rendered-review/annotation-domain";
import { type BrowserCache, openBrowserCache } from "@rendered-review/browser-cache";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { type PrIdentity, viewerQuery } from "../github/queries";
import { expectNoSeriousA11yViolations } from "../test-utils";
import { authorizePublicComments, signIn } from "../ui/Viewer";
import { HEAD } from "./fixtures";
import { NewConversationComment } from "./NewComment";

vi.mock("../ui/Viewer", () => ({ authorizePublicComments: vi.fn(async () => {}), signIn: vi.fn(async () => {}) }));

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Viewer = { signInEnabled: boolean; signedIn: boolean; login?: string };

function mount(
  viewer: Viewer = { signInEnabled: true, signedIn: true, login: "octocat" },
  response: () => Response = () => Response.json({ comment: { id: 1 } }, { status: 201 }),
  cache: BrowserCache = openBrowserCache(),
) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response());
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  client.setQueryData(viewerQuery.queryKey, viewer);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const ui = (
    <QueryClientProvider client={client}>
      <NewConversationComment id={id} isPrivate cache={cache} />
    </QueryClientProvider>
  );
  const { unmount } = render(ui);
  const sent = () =>
    fetch.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init.body as string) as Record<string, unknown> }));
  return { sent, invalidate, remount: () => (unmount(), render(ui)) };
}

const box = () => screen.getByRole("textbox", { name: "Add a comment" });
const status = () => screen.getByRole("status", { name: "Publishing status" });

it("posts a plain conversation comment with no annotation marker", async () => {
  const { sent } = mount();
  expect(screen.getByRole("region", { name: "Add a comment" })).toBeTruthy();
  await userEvent.type(box(), "Looks good to me.");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(sent()).toEqual([
    {
      url: `${WRITE}/comment`,
      body: { representation: "conversation", body: "Looks good to me.", expectedHeadOid: HEAD },
    },
  ]);
  expect(extractAnnotation(sent()[0]!.body.body as string).status).toBe("none");
});

it("on success clears the box, refreshes the conversation, announces it and keeps focus in the box", async () => {
  const { invalidate } = mount();
  await userEvent.type(box(), "Thanks!");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  await vi.waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe(""));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: expect.arrayContaining(["issue-comments"]) });
  expect(status().textContent).toBe("Comment posted");
  expect(document.activeElement).toBe(box());
});

it("submits with Ctrl+Enter or Cmd+Enter, and Escape keeps the text", async () => {
  const { sent } = mount();
  await userEvent.type(box(), "First");
  await userEvent.keyboard("{Escape}");
  expect((box() as HTMLTextAreaElement).value).toBe("First");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe(""));
  await userEvent.type(box(), "Second");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  await vi.waitFor(() => expect(sent().map((s) => s.body.body)).toEqual(["First", "Second"]));
});

it("can't post an empty comment", async () => {
  const { sent } = mount();
  const button = screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await userEvent.type(box(), "   ");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(button.disabled).toBe(true);
  expect(sent()).toEqual([]);
});

it("previews the comment as Markdown", async () => {
  mount();
  await userEvent.type(box(), "**bold**");
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  const region = screen.getByRole("region", { name: "Add a comment" });
  expect(within(region).getByText("bold").tagName).toBe("STRONG");
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect((box() as HTMLTextAreaElement).value).toBe("**bold**");
});

it("keeps the text and explains a refusal", async () => {
  mount(undefined, () => Response.json({ code: "rate-limited", message: "slow down" }, { status: 429 }));
  await userEvent.type(box(), "Keep me");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect((await screen.findByRole("alert")).textContent).toBe("GitHub's rate limit was reached. Try again later.");
  expect((box() as HTMLTextAreaElement).value).toBe("Keep me");
  expect(status().textContent).toBe("");
});

it("asks GitHub for public-repository permission when publishing needs it", async () => {
  mount(undefined, () =>
    Response.json({ code: "needs-public-authorization", message: "Allow it" }, { status: 403 }),
  );
  await userEvent.type(box(), "Hello");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/permission to comment on public repositories/);
  expect(authorizePublicComments).toHaveBeenCalled();
  expect((box() as HTMLTextAreaElement).value).toBe("Hello");
});

it("keeps unsent text when the Overview is left and opened again", async () => {
  const { remount } = mount();
  await userEvent.type(box(), "Unsent");
  remount();
  await vi.waitFor(() => expect((box() as HTMLTextAreaElement).value).toBe("Unsent"));
});

it("offers sign-in instead of a box to signed-out readers", async () => {
  mount({ signInEnabled: true, signedIn: false });
  expect(screen.queryByRole("textbox")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Sign in to comment" }));
  expect(signIn).toHaveBeenCalled();
});

it("shows nothing when this server offers no sign-in", () => {
  mount({ signInEnabled: false, signedIn: false });
  expect(screen.queryByRole("region", { name: "Add a comment" })).toBeNull();
});

it("has no serious accessibility violations", async () => {
  mount();
  await userEvent.type(box(), "Hi");
  await expectNoSeriousA11yViolations();
});
