// SPDX-License-Identifier: AGPL-3.0-only
import type { Element, Nodes } from "hast";
import { describe, expect, test } from "vitest";
import { renderMarkdown } from "./render.js";
import type { ResourceOptions } from "./resources.js";

const location = {
  host: "github.com",
  owner: "acme",
  repo: "specs",
  commitOid: "0123456789abcdef0123456789abcdef01234567",
  path: "docs/guide.md",
};

function links(markdown: string, options: ResourceOptions = { location }): Element[] {
  const found: Element[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element" && node.tagName === "a") found.push(node);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(renderMarkdown(markdown, options).tree);
  return found;
}
const opensNewTab = (a: Element | undefined) => ({ target: a?.properties.target, rel: a?.properties.rel });
const NEW_TAB = { target: "_blank", rel: ["noopener", "noreferrer"] };
const SAME_TAB = { target: undefined, rel: undefined };

describe("external links open in a new tab without a referrer", () => {
  test.each([
    ["an absolute https link", "[x](https://example.com/a)"],
    ["an http autolink", "www.example.com"],
    ["a GitHub permalink", "[x](https://github.com/acme/specs/blob/abc/a.md#L3)"],
    ["a repository link resolved to its GitHub blob", "[x](other.txt)"],
    ["a protocol-relative link", "[x](//example.com/x)"],
    ["an uppercase protocol-relative link in raw HTML", '<a href=" //EXAMPLE.com/x">x</a>'],
  ])("%s", (_, markdown) => {
    expect(opensNewTab(links(markdown)[0])).toEqual(NEW_TAB);
  });

  test("in comments rendered without a location", () => {
    expect(opensNewTab(links("See https://example.com", {})[0])).toEqual(NEW_TAB);
  });

  test("a link wrapping an external-image placeholder", () => {
    const [outer] = links("[![build](https://img.shields.io/b.svg)](https://ci.example/run)");
    expect(outer!.properties.href).toBe("https://ci.example/run");
    expect(opensNewTab(outer)).toEqual(NEW_TAB);
  });
});

describe("in-app links stay in the same tab", () => {
  test("fragment links", () => {
    expect(opensNewTab(links("[x](#usage)")[0])).toEqual(SAME_TAB);
  });

  test("repository links the resolver maps to an in-app route", () => {
    const [a] = links("[x](other.md#top)", { location, resolveLink: (path) => `/app?doc=${path}` });
    expect(a!.properties.href).toBe("/app?doc=docs/other.md");
    expect(opensNewTab(a)).toEqual(SAME_TAB);
  });

  test("mailto links", () => {
    expect(opensNewTab(links("me@example.com")[0])).toEqual(SAME_TAB);
  });

  test("relative links left untouched without a location", () => {
    expect(opensNewTab(links("[x](other.md)", {})[0])).toEqual(SAME_TAB);
  });
});
