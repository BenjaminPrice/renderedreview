// SPDX-License-Identifier: AGPL-3.0-only
import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@rendered-review/runtime";
import { appJwt, createInstallationCheck, installationCheckFor } from "./installation";

// GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY") keys; PKCS#8 works too.
const { privateKey: pkcs1, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("appJwt", () => {
  it.each([
    ["PKCS#1", pkcs1],
    ["PKCS#8", createPrivateKey(pkcs1).export({ type: "pkcs8", format: "pem" }) as string],
  ])("signs an RS256 app JWT from a %s key", async (_, pem) => {
    const now = Date.UTC(2026, 8, 24, 12);
    const jwt = await appJwt("12345", pem, now);
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    // Issued a minute early for clock drift; GitHub rejects expiry more than ten minutes out.
    expect(decode(payload!)).toEqual({ iss: "12345", iat: now / 1000 - 60, exp: now / 1000 + 540 });
    expect(
      verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url")),
    ).toBe(true);
  });
});

describe("createInstallationCheck", () => {
  const reply = (status: number) => vi.fn(async () => new Response("{}", { status }));

  it("asks GitHub for the repository's installation of this app, with an app JWT", async () => {
    const fetch = reply(200);
    const installed = createInstallationCheck({ appId: "12345", privateKey: pkcs1, fetch });
    expect(await installed("github.com", "acme", "widgets")).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/installation");
    const auth = new Headers(init.headers).get("authorization")!;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(decode(auth.split(" ")[1]!.split(".")[1]!).iss).toBe("12345");
  });

  it("is not installed on a 404, and caches the answer briefly per repository", async () => {
    const fetch = reply(404);
    const installed = createInstallationCheck({ appId: "1", privateKey: pkcs1, fetch });
    expect(await installed("github.com", "acme", "widgets")).toBe(false);
    expect(await installed("github.com", "Acme", "Widgets")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000, toFake: ["Date"] });
    try {
      await installed("github.com", "acme", "widgets");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on other GitHub failures rather than guessing", async () => {
    const installed = createInstallationCheck({ appId: "1", privateKey: pkcs1, fetch: reply(500) });
    await expect(installed("github.com", "acme", "widgets")).rejects.toThrow(/HTTP 500/);
  });

  it("is never installed on another host (the app is on github.com)", async () => {
    const fetch = reply(200);
    const installed = createInstallationCheck({ appId: "1", privateKey: pkcs1, fetch });
    expect(await installed("ghe.example.com", "acme", "widgets")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("installationCheckFor", () => {
  it("is one shared check per config, and none without a GitHub App", () => {
    const withApp = loadConfig({
      HOSTING_MODE: "community",
      ACCESS_POLICY: "disabled",
      GITHUB_APP_ID: "1",
      GITHUB_APP_CLIENT_ID: "Iv23.x",
      GITHUB_APP_CLIENT_SECRET: "s",
      GITHUB_APP_PRIVATE_KEY: pkcs1,
      GITHUB_APP_WEBHOOK_SECRET: "w",
      ENCRYPTION_KEY: btoa("k".repeat(32)),
      BETTER_AUTH_SECRET: "s".repeat(32),
      DATABASE_URL: "sqlite::memory:",
    });
    expect(installationCheckFor(withApp)).toBeTypeOf("function");
    expect(installationCheckFor(withApp)).toBe(installationCheckFor(withApp));
    expect(installationCheckFor(loadConfig({ HOSTING_MODE: "community", ACCESS_POLICY: "disabled" }))).toBeUndefined();
  });
});
