// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { rewriteDocHref } from "./docs-links";

const published = new Set(["deploy-cloudflare", "observability"]);
const rewrite = (href: string) => rewriteDocHref(href, "docs/deploy-site.md", published);
const REPO = "https://github.com/BenjaminPrice/renderedreview";

describe("rewriteDocHref", () => {
  it("points links to published docs at their site page, keeping the anchor", () => {
    expect(rewrite("deploy-cloudflare.md")).toEqual({ href: "/docs/deploy-cloudflare/", external: false });
    expect(rewrite("./observability.md#what-is-logged")).toEqual({
      href: "/docs/observability/#what-is-logged",
      external: false,
    });
  });

  it("points other repository paths at GitHub", () => {
    expect(rewrite("../README.md#configuration")).toEqual({
      href: `${REPO}/blob/main/README.md#configuration`,
      external: true,
    });
    expect(rewrite("security/threat-model.md")).toEqual({
      href: `${REPO}/blob/main/docs/security/threat-model.md`,
      external: true,
    });
  });

  it("leaves same-page anchors alone and marks other sites external", () => {
    expect(rewrite("#environments")).toEqual({ href: "#environments", external: false });
    expect(rewrite("https://astro.build")).toEqual({ href: "https://astro.build", external: true });
    expect(rewrite("mailto:someone@example.com")).toEqual({ href: "mailto:someone@example.com", external: true });
  });
});
