// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from "node:crypto";
import { loadConfig } from "@rendered-review/runtime";
import { describe, expect, it, vi } from "vitest";
import { installRedirect, setupRedirect } from "./install-redirect";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const appConfig = () =>
  loadConfig({
    HOSTING_MODE: "community",
    ACCESS_POLICY: "installed",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_CLIENT_ID: "Iv23.x",
    GITHUB_APP_CLIENT_SECRET: "s",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_WEBHOOK_SECRET: "w",
    ENCRYPTION_KEY: btoa("k".repeat(32)),
    BETTER_AUTH_SECRET: "s".repeat(32),
    DATABASE_URL: "sqlite::memory:",
  });
const ORIGIN = "https://rr.example";
const PR = "/github.com/acme/widgets/pull/7";
// Trimmed from GitHub's `GET /app` response.
const app = () =>
  vi.fn(async () =>
    Response.json({ id: 12345, slug: "rendered-review", html_url: "https://github.com/apps/rendered-review" }),
  );

const unsafe = [
  ["a protocol-relative URL", "//evil.example/x"],
  ["an absolute URL", "https://evil.example/x"],
  ["a backslash that browsers read as a slash", "/\\evil.example"],
  ["a tab the URL parser strips", "/\t/evil.example"],
  ["a javascript: URL", "javascript:alert(1)"],
  ["a relative path", "github.com/acme/widgets/pull/7"],
];

describe("setupRedirect (the GitHub App's Setup URL)", () => {
  const setup = (query: string) => setupRedirect(new Request(`${ORIGIN}/api/github/setup?${query}`));

  it("returns to the pull request carried in state", () => {
    const res = setup(
      `installation_id=42&setup_action=install&state=${encodeURIComponent(`${PR}?file=README.md#intro`)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}${PR}?file=README.md#intro`);
  });

  it.each(unsafe)("goes home instead of following %s", (_, state) => {
    expect(setup(`setup_action=install&state=${encodeURIComponent(state)}`).headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("keeps a path that normalizes to a double slash on this origin", () => {
    expect(setup(`state=${encodeURIComponent("/.//evil.example")}`).headers.get("location")).toBe(
      `${ORIGIN}//evil.example`,
    );
  });

  it("goes home without state", () => {
    expect(setup("setup_action=request").headers.get("location")).toBe(`${ORIGIN}/`);
  });
});

describe("installRedirect", () => {
  const install = (query: string, fetch = app(), config = appConfig()) =>
    installRedirect(new Request(`${ORIGIN}/api/github/install?${query}`), config, fetch);

  it("sends the user to the app's install page with the pull request as state", async () => {
    const fetch = app();
    const res = await install(`return=${encodeURIComponent(PR)}`, fetch);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://github.com/apps/rendered-review/installations/new?state=${encodeURIComponent(PR)}`,
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app");
    expect(new Headers(init.headers).get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it.each(unsafe)("drops a return of %s", async (_, target) => {
    const res = await install(`return=${encodeURIComponent(target)}`);
    expect(res.headers.get("location")).toBe("https://github.com/apps/rendered-review/installations/new");
  });

  it("looks the app up once per config", async () => {
    const fetch = app();
    const config = appConfig();
    await install("", fetch, config);
    await install("", fetch, config);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("answers 502 when GitHub fails, and retries next time", async () => {
    const config = appConfig();
    const failing = vi.fn(async () => new Response("{}", { status: 500 }));
    expect((await install("", failing, config)).status).toBe(502);
    expect((await install("", app(), config)).status).toBe(302);
  });

  it("does not exist without a GitHub App", async () => {
    const res = await install("", app(), loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" }));
    expect(res.status).toBe(404);
  });
});
