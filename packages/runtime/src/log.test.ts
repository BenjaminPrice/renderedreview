// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorName, log } from "./log";

const TOKEN = "ghu_16C7e42F292c6912E7710c838347Ae178B4a";
const BODY = "Please rename this function\n\n<!-- rendered-review:annotation v1 eyJ0YXJnZXQiOnt9fQ== -->";

function capture(level: "info" | "warn" | "error" = "info") {
  const spy = vi.spyOn(console, level).mockImplementation(() => {});
  return () => spy.mock.calls.map(([line]) => (typeof line === "string" ? JSON.parse(line) : line) as object);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("log", () => {
  it("emits one JSON line per event with its level, event name and safe fields", () => {
    const lines = capture("warn");
    log.warn("github.request", { host: "github.com", route: "/repos/:/:/pulls/:", status: 403, durationMs: 12.6 });
    expect(lines()).toEqual([
      {
        level: "warn",
        event: "github.request",
        host: "github.com",
        route: "/repos/:/:/pulls/:",
        status: 403,
        durationMs: 13,
      },
    ]);
  });

  it("logs info and error to their console levels", () => {
    const info = capture("info");
    const error = capture("error");
    log.info("a.ok");
    log.error("a.failed", { category: "boom" });
    expect(info()).toEqual([{ level: "info", event: "a.ok" }]);
    expect(error()).toEqual([{ level: "error", event: "a.failed", category: "boom" }]);
  });

  it("drops fields that are not on the allowlist, whatever they hold", () => {
    const lines = capture();
    log.info("publish.result", {
      category: "published",
      token: TOKEN,
      authorization: `Bearer ${TOKEN}`,
      body: BODY,
      email: "octocat@example.com",
      path: "docs/secret-plans.md",
    } as never);
    expect(lines()).toEqual([{ level: "info", event: "publish.result", category: "published" }]);
  });

  it("drops allowlisted fields of the wrong type or with unsafe characters", () => {
    const lines = capture();
    log.info("x", {
      status: "500" as never,
      count: { nested: TOKEN } as never,
      category: BODY,
      host: "octocat@example.com",
      route: "/repos/acme/app?access_token=abc",
      outcome: ["ok"] as never,
      durationMs: Number.NaN,
    });
    const text = JSON.stringify(lines());
    expect(lines()).toEqual([{ level: "info", event: "x" }]);
    expect(text).not.toMatch(/ghu_|annotation|octocat|access_token/);
  });

  it("caps string length so no field can smuggle a document", () => {
    const lines = capture();
    log.info("x", { category: "a".repeat(500) });
    expect((lines()[0] as { category: string }).category).toHaveLength(100);
  });

  it("replaces an unsafe event name instead of logging it", () => {
    const lines = capture();
    log.info(`leak ${TOKEN}`);
    log.info("x".repeat(100));
    expect(lines()).toEqual([
      { level: "info", event: "invalid-event" },
      { level: "info", event: "invalid-event" },
    ]);
  });

  it("hands Workers Logs an object, so its fields are indexed", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("a.ok", { count: 2 });
    expect(spy).toHaveBeenCalledWith({ level: "info", event: "a.ok", count: 2 });
  });
});

describe("errorName", () => {
  it("names the error class, never its message", () => {
    expect(errorName(new TypeError(`bad token ${TOKEN}`))).toBe("TypeError");
    expect(errorName("a string with secrets")).toBe("unknown");
  });
});
