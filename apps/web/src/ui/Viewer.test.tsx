// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewerSlot } from "./Viewer";

const octocat = { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" };
let viewer: Response;
const requests: Request[] = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), location.href), init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/viewer") return viewer.clone();
    if (path === "/api/auth/sign-in/social") {
      return Response.json({ url: "https://github.com/login/oauth/authorize?client_id=x", redirect: true });
    }
    if (path === "/api/auth/sign-out") return Response.json({ success: true });
    return new Response("Not Found", { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("offers GitHub sign-in when signed out, returning to the exact current URL", async () => {
  viewer = Response.json(null);
  history.replaceState(null, "", "/github.com/mdn/content/pull/45377?doc=a.md&thread=9#rr-thread-9");
  const navigate = vi.fn();
  render(<ViewerSlot navigate={navigate} />);
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
  const start = requests.find((r) => r.url.endsWith("/api/auth/sign-in/social"))!;
  expect(start.method).toBe("POST");
  expect(await start.json()).toEqual({
    provider: "github",
    callbackURL: "/github.com/mdn/content/pull/45377?doc=a.md&thread=9#rr-thread-9",
  });
  expect(navigate).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?client_id=x");
});

it("shows the signed-in user's avatar and login, and signs out, reloading to drop per-user data", async () => {
  viewer = Response.json(octocat);
  const navigate = vi.fn();
  render(<ViewerSlot navigate={navigate} />);
  expect(await screen.findByText("octocat")).toBeTruthy();
  expect(document.querySelector("img")?.getAttribute("src")).toBe(octocat.avatarUrl);
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/api/auth/sign-out"))).toBe(true);
  expect(await screen.findByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  expect(screen.queryByText("octocat")).toBeNull();
  expect(navigate).toHaveBeenCalledWith(location.href);
});

it("shows nothing when sign-in is not available on this deployment", async () => {
  viewer = new Response("Not Found", { status: 404 });
  const { container } = render(<ViewerSlot navigate={vi.fn()} />);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(container.innerHTML).toBe("");
});
